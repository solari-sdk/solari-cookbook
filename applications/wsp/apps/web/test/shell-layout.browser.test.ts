// SPDX-License-Identifier: AGPL-3.0-only
// The shell's chrome in a real Chromium: the sidebar toggle starts where the
// search row does and the brand lockup one gap after it, the two top rows are
// one height and start where the workspace rows do, the
// search row is a plain row that opens the palette without moving a row, a
// thread row's title keeps its room at the default width with the agent's
// mark before it and one slot after it, a toast holds a long token inside its box off the sidebar, the
// line for a provider out of reach is one muted mono line under the
// search row, the line the runtime puts on a machine's row takes that row's second line whole,
// uncut and without growing the row, collapsing the sidebar leaves the
// page header's left padding alone, a send refusal above the composer is
// one muted mono line in a slot the composer keeps at one height whether or
// not a line is in it, images pasted into the composer are one row of square
// thumbnails above the text inside the box, each with its own remove,
// a right-click on a workspace row opens the in-app menu
// at the pointer in the tooltip skin, inside the viewport, Rename turns a
// thread row's title and a workspace row's name into one field in the same
// slot at the same row height, and the switch
// chord held down puts the workspace switcher up, its cards three parts
// each, without moving the shell under it, and at three sidebar widths the
// workspace and thread rows keep one grammar: one height per row kind, the
// state word in its slot at the right edge only off running, the meta line
// cut from the right, no import or export glyph, the thread
// title up to its one slot, the Spaces body draws one workspace
// under its header with an icon per workspace centred at the sidebar's
// bottom and no Workspaces header over it, a workspace's own theme paints
// the sidebar's surface and its glyph in Spaces and nothing in the list, the
// move to another space travels that body out the way it was pushed and the
// next one in from the other side while the header and the space bar hold
// still, or swaps it with no travel for a reader who asked for less motion,
// a mixed list of a local machine and two cloud ones keeps that one
// grammar with no glyph in any lead, and the threads quiet for
// over a day sit in an Archived group shut under that workspace's idle
// threads, in the fold row's own grammar. Vite
// serves test/shell to Playwright's browser, so like the glyph test it runs
// only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium
// on the machine.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, ConsoleMessage, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCESS_REFUSED_LINE, accessReachLine, contrastRatio, DEFAULT_THEME, dotColour, effectiveOpacity, FREE_WORD, INK_FLOOR, PROVIDER_UNREACHED_LINE, sendRefusal, SIDE_INK, stillWorkingLine, THEME_PRESETS, themeInk, themeScheme, type Rgb } from "@wsp/protocol";
import { WAKE_AND_SEND_LABEL } from "../src/components/chat/ComposerPrimaryActions";
import { LOCKUP_OPTICAL_CENTRE } from "../src/brand/optical";
import { WHERE_WORDS } from "../src/settings/format";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
/** What React says when one body is drawn as both panes. The case that watches for it wants this line and not
 * whatever else a browser puts on the console. */
const DUPLICATE_KEY = "two children with the same key";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

if (renderSkipped !== undefined) console.info(`shell layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the shell's chrome laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    // Each case starts the page as a first visit: what one case selects or opens is not the next one's memory.
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  async function open(theme: "dark" | "light"): Promise<void> {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-sidebar-row]");
  }
  const rowGap = (selector: string): Promise<number> => page!.locator(selector).first().evaluate(el => parseFloat(getComputedStyle(el).columnGap));
  const box = async (selector: string): Promise<Box> => {
    const b = await page!.locator(selector).first().boundingBox();
    if (!b) throw new Error(`${selector} has no box`);
    return b;
  };
  /** Several boxes read in one frame once every finite animation on the page has run out, so a glide in flight
   * between two reads cannot put them out of step. Spinners run forever and are left out. */
  const settledBoxes = <const S extends readonly string[]>(selectors: S): Promise<{ [K in keyof S]: Box }> =>
    page!.evaluate(async (sels: readonly string[]) => {
      const frame = (): Promise<unknown> => new Promise(done => requestAnimationFrame(done));
      for (;;) {
        await frame();
        await frame();
        const running = document.getAnimations().filter(a => a.effect?.getComputedTiming().endTime !== Infinity);
        if (running.length === 0) break;
        await Promise.all(running.map(a => a.finished.catch(() => undefined)));
      }
      return sels.map(sel => {
        const el = document.querySelector(sel);
        if (el === null) throw new Error(`${sel} has no box`);
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
    }, selectors) as Promise<{ [K in keyof S]: Box }>;

  it("the sidebar toggle starts where the search row does and the brand lockup one gap after it, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const toggle = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger]");
      const lockup = await box("[data-slot=sidebar-header] [role=img][aria-label=wsp]");
      const search = await box("button[aria-label='Search']");
      expect(Math.abs(toggle.x - search.x)).toBeLessThan(1);
      expect(Math.abs(lockup.x - (toggle.x + toggle.width + (await rowGap("[data-slot=sidebar-header]"))))).toBeLessThan(1);
      // One vertical centre: the toggle glyph's ink (its icon box, whose panel fills it edge to edge) and the wordmark's optical centre.
      const glyph = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger] svg");
      expect(Math.abs(glyph.y + glyph.height / 2 - (lockup.y + lockup.height * LOCKUP_OPTICAL_CENTRE))).toBeLessThan(0.5);
      const path = join(SHOTS_DIR, `sidebar-header-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar header screenshot: ${path}`);
    }
  }, 30_000);

  it("in the desktop window a translucent Ghostty config opens a hole under the terminal canvas alone: the tab strip keeps the Browser tab's background, in dark the centre's share moves off the column onto the thread and its header, every layer under the canvas is clear and the canvas backing carries the file's alpha, in both themes", async () => {
    // What an element sits on: the first painted background walking up from it, or "none" when the window shows through.
    const backdrops = () =>
      page!.evaluate(() => {
        const on = (selector: string): string => {
          for (let n: Element | null = document.querySelector(selector)!; n !== null; n = n.parentElement) {
            const c = getComputedStyle(n).backgroundColor;
            if (c !== "rgba(0, 0, 0, 0)") return c;
          }
          return "none";
        };
        return {
          strip: on("[data-right-panel-tabbar]"),
          centre: on("[data-shell-center]"),
          header: on("[data-shell-center] > header"),
          beside: on("[data-terminal-beside]"),
          canvas: on("[data-terminal-viewport] canvas"),
        };
      });
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a&mac=1&panel=terminal`);
      await page!.waitForSelector("[data-terminal-translucent] canvas");
      const terminal = await backdrops();
      // The corner pixel of the canvas backing: the theme's background at the file's alpha, so the material behind shows through it.
      const alpha = await page!.locator("[data-terminal-viewport] canvas").evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(2, 2, 1, 1).data[3]!);
      expect(Math.abs(alpha - Math.round(0.85 * 255))).toBeLessThanOrEqual(2);
      expect(terminal.canvas).toBe("none");
      expect(await page!.locator("[data-right-panel-tab-list] [data-active-tab]").count()).toBe(2);
      await page!.locator("[data-right-panel-tab-list] [data-active-tab='false'] button:has(> span.truncate)").click();
      await page!.waitForSelector("[data-terminal-viewport]", { state: "detached" });
      const browser = await backdrops();
      expect(browser.strip).not.toBe("none");
      // The strip wears the panel's share and the centre its own; in dark mode on the Mac those differ on purpose.
      expect(terminal.strip).toBe(browser.strip);
      if (theme === "dark") {
        // In dark the glass shows through the canvas, so the centre column paints nothing and the thread and its header carry its share.
        expect(terminal.centre).toBe("none");
        expect(browser.centre).not.toBe("none");
        expect(terminal.header).toBe(browser.centre);
        expect(terminal.beside).toBe(browser.centre);
      } else {
        expect(terminal.centre).toBe(browser.centre);
      }
      await page!.locator("[data-right-panel-tab-list] [data-active-tab='false'] button:has(> span.truncate)").click();
      await page!.waitForSelector("[data-terminal-viewport] canvas");
      const path = join(SHOTS_DIR, `terminal-pane-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`terminal pane screenshot: ${path}`);
    }
  }, 60_000);

  it("in the desktop window the terminal draws at the app's own text size over a file saying 16, and at the file's 16 once the record says the size comes from the file", async () => {
    const read = async (query: string) => {
      await page!.goto(`${base}?theme=dark&ws=ws_a&mac=1&panel=terminal${query}`);
      await page!.waitForSelector("[data-terminal-translucent] canvas");
      await page!.waitForFunction(() => (window as unknown as { surfaces: unknown[] }).surfaces.length > 0);
      return page!.evaluate(() => {
        const [surface] = (window as unknown as { surfaces: { textSize: number; cellHeight: number }[] }).surfaces;
        const app = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--font-size-terminal"));
        return { textSize: surface!.textSize, cellHeight: surface!.cellHeight, app };
      });
    };
    const fromApp = await read("");
    console.info(`terminal size with the app as the source: ${JSON.stringify(fromApp)}`);
    expect(fromApp.textSize).toBe(fromApp.app);
    const fromFile = await read("&size=file");
    console.info(`terminal size with the file as the source: ${JSON.stringify(fromFile)}`);
    expect(fromFile.textSize).toBe(16);
    // The cells grow with the text: the file's 16 over the app's 14 is two pixels of text and at least that of cell.
    expect(fromFile.cellHeight - fromApp.cellHeight).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("holding the switch chord puts the switcher up over the shell, one card per workspace of three parts, and the highlight moves nothing", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&shell=desktop`);
      await page!.waitForSelector("[data-sidebar-row]");
      const sidebar = await box("[data-slot=sidebar]");
      await page!.keyboard.down("Control");
      await page!.keyboard.press("Tab");
      await page!.waitForSelector("[data-workspace-switcher]");
      const cards = page!.locator("[data-workspace-card]");
      expect(await cards.count()).toBe(3);
      const boxes = await cards.evaluateAll(els => els.map(el => JSON.stringify(el.getBoundingClientRect().toJSON())));
      expect(new Set(await cards.evaluateAll(els => els.map(el => el.getBoundingClientRect().height))).size).toBe(1);
      // Three parts, in one order, on every card: the well, the name in sans, the thread's title in muted mono.
      const parts = await cards.evaluateAll(els =>
        els.map(el =>
          [...el.children].map(child => child.getAttributeNames().find(name => name.startsWith("data-card-"))?.slice("data-card-".length) ?? "?").join(","),
        ),
      );
      expect(parts).toEqual(["preview,name,thread", "preview,name,thread", "preview,name,thread"]);
      const fonts = await cards.evaluateAll(els =>
        els.map(el => {
          const mono = (part: string): boolean => /mono/i.test(getComputedStyle(el.querySelector(`[data-card-${part}]`)!).fontFamily);
          return { name: mono("name"), thread: mono("thread") };
        }),
      );
      expect(fonts).toEqual([...Array(3)].map(() => ({ name: false, thread: true })));
      // No cost, no state word and no open word on any card: the state is read off the preview and the sidebar.
      for (const text of await cards.evaluateAll(els => els.map(el => el.textContent ?? ""))) expect(text).not.toMatch(/\$|Running|Paused|Gone|open/);
      expect(await page!.locator("[data-workspace-card][aria-selected=true]").getAttribute("data-workspace-card")).toBe("ws_b");
      // No card here has a picture yet, so every well is the empty one. Its fill cannot hold an edge on a
      // light card (1.02 against the white under it), so the hairline is what says where the box is, and
      // it has to be there on both surfaces.
      const wells = await page!.locator("[data-card-preview]").evaluateAll(els =>
        els.map(el => {
          const shadows = getComputedStyle(el).boxShadow.match(/((?:rgba?|color|oklch|oklab)\([^)]*\))/g) ?? [];
          return { empty: el.hasAttribute("data-card-preview-empty"), rings: shadows.filter(c => !/[,/]\s*0\)$/.test(c)).length };
        }),
      );
      expect(wells).toHaveLength(3);
      for (const well of wells) {
        expect(well.empty, `a card's well is not the empty one in ${theme}`).toBe(true);
        expect(well.rings, `the empty well carries no hairline in ${theme}`).toBeGreaterThan(0);
      }
      await page!.screenshot({ path: join(SHOTS_DIR, `workspace-switcher-${theme}.png`) });
      console.info(`workspace switcher screenshot: ${join(SHOTS_DIR, `workspace-switcher-${theme}.png`)}`);
      await page!.keyboard.press("Tab");
      await page!.waitForFunction(() => document.querySelector("[data-workspace-card][aria-selected=true]")?.getAttribute("data-workspace-card") === "ws_c");
      expect(await cards.evaluateAll(els => els.map(el => JSON.stringify(el.getBoundingClientRect().toJSON())))).toEqual(boxes);
      expect(await box("[data-slot=sidebar]")).toEqual(sidebar);
      await page!.keyboard.up("Control");
      await page!.waitForSelector("[data-workspace-switcher]", { state: "detached" });
    }
  }, 60_000);

  it("a thread row keeps twelve characters of a long title at the default width, the agent's bare mark before it and one slot after it, rows one height", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const rows = await page!.locator("[data-row-id^='thread:']").evaluateAll(els =>
        els.map(el => {
          const title = el.querySelector<HTMLElement>("[data-thread-title]");
          const mark = el.querySelector<HTMLElement>("[data-harness-mark]");
          const slot = el.querySelector<HTMLElement>("[data-thread-state], [data-thread-time]");
          if (!title || !mark || !slot) return null;
          const font = getComputedStyle(title);
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
          const markBox = mark.getBoundingClientRect();
          const titleBox = title.getBoundingClientRect();
          const paint = getComputedStyle(mark);
          return {
            height: el.getBoundingClientRect().height,
            titleWidth: title.clientWidth,
            twelveChars: ctx.measureText((title.textContent ?? "").slice(0, 12)).width,
            title: title.textContent ?? "",
            face: el.textContent ?? "",
            slot: slot.textContent ?? "",
            slotClipped: slot.scrollWidth > slot.clientWidth,
            slotMono: /mono/i.test(getComputedStyle(slot).fontFamily),
            hover: el.getAttribute("title"),
            mark: mark.getAttribute("data-harness-mark"),
            markSize: [markBox.width, markBox.height],
            // The mark's centre against the title's centre: optically on the line, not hanging above it.
            markOffset: markBox.y + markBox.height / 2 - (titleBox.y + titleBox.height / 2),
            markColor: paint.color,
            titleColor: font.color,
            bare: paint.backgroundColor === "rgba(0, 0, 0, 0)" && paint.borderTopWidth === "0px" && paint.boxShadow === "none",
          };
        }),
      );
      console.info(`thread rows at ${theme}: ${JSON.stringify(rows)}`);
      // The agent, the project and who opened it ride the hover text; the face is the title and the slot alone.
      expect(rows.map(r => r?.hover)).toEqual(["Claude Code, the-project, you", "Claude Code, the-project, cli", "Codex, the-project, cli", "Claude Code, the-project, you"]);
      expect(rows[0]!.slot).toBe("Working");
      for (const row of rows.slice(1)) expect(row!.slot).toMatch(/^(now|\d+[mhd])$/);
      for (const row of rows) {
        expect(row!.face).toBe(`${row!.title}${row!.slot}`);
        expect(row!.titleWidth).toBeGreaterThanOrEqual(row!.twelveChars);
        expect(row!.slotClipped).toBe(false);
        expect(row!.slotMono).toBe(true);
        // Bare marks of 13 to 16 px, centred on the title beside them, in a colour of their own, on nothing.
        for (const side of row!.markSize) {
          expect(side).toBeGreaterThanOrEqual(13);
          expect(side).toBeLessThanOrEqual(16);
        }
        expect(Math.abs(row!.markOffset)).toBeLessThan(1.5);
        expect(row!.bare).toBe(true);
      }
      // Claude's mark is its terracotta; OpenAI's is monochrome by design, so it takes the row's ink.
      const colours = new Map(rows.map(r => [r!.mark, r!.markColor]));
      expect(colours.size).toBe(2);
      expect(colours.get("claude")).not.toBe(colours.get("codex"));
      expect(new Set(rows.map(r => r!.height)).size).toBe(1);
      expect(rows[0]!.height).toBe(36);
      const path = join(SHOTS_DIR, `sidebar-threads-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar thread rows screenshot: ${path}`);
    }
  }, 30_000);

  it("an idle title sits closer to the background than a working one, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const titles = await page!.locator("[data-row-id^='thread:']").evaluateAll(rows => {
        // The tokens compute to oklab(), which no regex reads as channels: rasterize each one and read the sRGB bytes back.
        const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d")!;
        const bytes = (color: string): number[] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "#000000";
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data];
        };
        const luminance = (color: string): number => {
          const [r = 0, g = 0, b = 0] = bytes(color).slice(0, 3).map(c => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const backdrop = (el: Element): string => {
          for (let node: Element | null = el; node !== null; node = node.parentElement) {
            const painted = getComputedStyle(node).backgroundColor;
            if (bytes(painted)[3] === 255) return painted;
          }
          return getComputedStyle(document.documentElement).backgroundColor;
        };
        return rows.map(row => {
          const el = row.querySelector<HTMLElement>("[data-thread-title]")!;
          const color = getComputedStyle(el).color;
          return {
            text: el.textContent ?? "",
            // Which row is the working one comes from the row's own slot, not from where it sits in the list.
            working: row.querySelector("[data-thread-state]")?.textContent === "Working",
            color,
            opaque: bytes(color)[3] === 255,
            gap: Math.abs(luminance(color) - luminance(backdrop(el))),
          };
        });
      });
      console.info(`thread titles at ${theme}: ${JSON.stringify(titles)}`);
      const [working, ...idles] = [...titles].sort((a, b) => Number(b.working) - Number(a.working));
      expect(titles.filter(t => t.working)).toHaveLength(1);
      expect(idles).toHaveLength(3);
      for (const idle of idles) {
        expect(idle.color).not.toBe(working!.color);
        expect(idle.gap).toBeLessThan(working!.gap);
      }
      const path = join(SHOTS_DIR, `sidebar-idle-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar idle group screenshot: ${path}`);
    }
  }, 30_000);

  it("the Archived group sits shut under the workspace's idle threads, a plain fold with no colour of its own, and opens to rows of the same height, in both themes", async () => {
    const readGroups = () =>
      page!.evaluate(() => {
        const read = (rowId: string) => {
          const row = document.querySelector<HTMLElement>(`[data-row-id='${rowId}']`)!;
          const word = row.querySelector<HTMLElement>("span")!;
          const box = row.getBoundingClientRect();
          const style = getComputedStyle(word);
          const rowStyle = getComputedStyle(row);
          return {
            text: row.getAttribute("aria-label"),
            expanded: row.getAttribute("aria-expanded"),
            y: box.y,
            height: box.height,
            x: box.x,
            right: box.right,
            color: style.color,
            size: style.fontSize,
            weight: style.fontWeight,
            background: rowStyle.backgroundColor,
            border: rowStyle.borderBottomWidth,
            radius: rowStyle.borderBottomRightRadius,
          };
        };
        // Only the first workspace's own block: the other two draw their own thread rows further down the list.
        const block = document.querySelector<HTMLElement>("[data-row-id='ws:ws_a']")!.closest<HTMLElement>("[data-sidebar='menu-item']")!;
        return {
          archived: read("archived:ws_a"),
          threads: Array.from(block.querySelectorAll<HTMLElement>("[data-row-id^='thread:']")).map(row => ({
            id: row.getAttribute("data-row-id"),
            y: row.getBoundingClientRect().y,
            height: row.getBoundingClientRect().height,
          })),
          sidebar: document.querySelector<HTMLElement>("[data-slot=sidebar]")!.getBoundingClientRect().right,
        };
      });
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&archived=1&sidebar=300`);
      await page!.waitForSelector("[data-row-id='archived:ws_a']");
      const shut = await readGroups();
      console.info(`archived group ${theme} shut: ${JSON.stringify(shut)}`);
      // Shut, carrying its count, under the workspace's idle threads rather than above them.
      expect(shut.archived.expanded).toBe("false");
      expect(shut.archived.text).toBe("Archived 2");
      // The two threads it holds are not drawn; the working row and the one idle row are.
      expect(shut.threads.map(t => t.id)).toEqual(["thread:s1", "thread:s2"]);
      for (const thread of shut.threads) expect(thread.y).toBeLessThan(shut.archived.y);
      // A fold is a label over rows, not a chip or a badge, so it carries no fill and no border of its own.
      expect(shut.archived.height).toBe(28);
      expect(shut.archived.background).toBe("rgba(0, 0, 0, 0)");
      expect(shut.archived.border).toBe("0px");
      expect(shut.archived.right).toBeLessThanOrEqual(shut.sidebar);
      const path = join(SHOTS_DIR, `sidebar-archived-shut-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar archived shut screenshot: ${path}`);
      // One click opens it, and what it holds are ordinary thread rows at the ordinary thread-row height.
      await page!.locator("[data-row-id='archived:ws_a']").click();
      await page!.waitForFunction(
        () => document.querySelector("[data-row-id='ws:ws_a']")!.closest("[data-sidebar='menu-item']")!.querySelectorAll("[data-row-id^='thread:']").length === 4,
      );
      // The chevron turns to point down in 150 ms; the shot waits for it to land, so it is a chevron and not a corner,
      // and the pointer leaves the row, so the fold carries no hover fill in the shot.
      await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-row-id='archived:ws_a'] svg")!).transform === "none");
      await page!.mouse.move(640, 760);
      await page!.waitForTimeout(200);
      const open = await readGroups();
      console.info(`archived group ${theme} open: ${JSON.stringify(open)}`);
      expect(open.archived.expanded).toBe("true");
      expect(open.archived.text).toBe("Archived");
      expect(open.threads.map(t => t.id)).toEqual(["thread:s1", "thread:s2", "thread:s5", "thread:s6"]);
      expect(new Set(open.threads.map(t => Math.round(t.height))).size).toBe(1);
      for (const id of ["thread:s5", "thread:s6"]) {
        expect(open.threads.find(t => t.id === id)!.y).toBeGreaterThan(open.archived.y);
      }
      const openPath = join(SHOTS_DIR, `sidebar-archived-open-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path: openPath });
      console.info(`sidebar archived open screenshot: ${openPath}`);
    }
  }, 60_000);

  it("a toast with a 200-character token stands top right of the centre pane, inside its box and off the sidebar, its where-and-when one line, at every width, in both themes", async () => {
    const token = "ZGVza3RvcC1wb29s".repeat(13).slice(0, 200);
    const toast = `${encodeURIComponent(`Stopped the builder ${token} to make room at the machine cap.`)}&where=${"spoo-".repeat(40)}`;
    for (const theme of ["dark", "light"] as const) {
      for (const width of [1200, 390]) {
        await page!.setViewportSize({ width, height: 800 });
        await page!.goto(`${base}?theme=${theme}&toast=${toast}`);
        const notice = page!.locator("[data-notice]").first();
        await notice.waitFor();
        const centre = await box("[data-shell-center]");
        const header = await box("[data-shell-center] header");
        const b = await box("[data-notice]");
        expect(b.x).toBeGreaterThanOrEqual(centre.x);
        expect(b.x + b.width).toBeLessThanOrEqual(centre.x + centre.width);
        expect(b.y).toBeGreaterThanOrEqual(header.y + header.height);
        expect(await notice.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
        expect(await notice.evaluate(el => el.closest("[data-app-sidebar]"))).toBeNull();
        const when = notice.locator("[data-notice-when]");
        expect((await when.boundingBox())!.height).toBeLessThan(20);
        expect(await when.textContent()).toMatch(/\d{2}:\d{2}$/);
        const path = join(SHOTS_DIR, `notice-${theme}-${width}.png`);
        await page!.screenshot({ path });
        console.info(`notice screenshot: ${path}`);
      }
    }
    await page!.setViewportSize({ width: 1200, height: 800 });
  }, 60_000);

  it("a prompt and a dead thread on a workspace not open stand as a waiting and an error notice, each with an Open, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&host=1`);
      await page!.locator("[data-notice]").nth(1).waitFor();
      const notices = await page!.locator("[data-notice]").evaluateAll(els => els.map(el => el.textContent ?? ""));
      console.info(`host notices at ${theme}: ${JSON.stringify(notices)}`);
      expect(notices).toHaveLength(2);
      expect(notices[0]).toMatch(/^waiting/);
      expect(notices[1]).toMatch(/^error/);
      expect(notices[1]).toContain("stopped before it replied: exit 1");
      expect(await page!.locator("[data-notice-action]").allTextContents()).toEqual(["Open", "Open"]);
      const path = join(SHOTS_DIR, `notice-host-${theme}.png`);
      await page!.locator("[data-notices]").screenshot({ path });
      console.info(`host notices screenshot: ${path}`);
    }
  }, 30_000);

  it("a shell older than the host that served the page says so in a toast, with the releases page behind its button, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&version=behind`);
      const notice = page!.locator("[data-notice]").first();
      await notice.waitFor();
      expect(await notice.textContent()).toContain("this app is 0.1.3, the host is 0.1.5: get the new app");
      expect(await page!.locator("[data-notice-action]").textContent()).toBe("Get");
      const path = join(SHOTS_DIR, `notice-version-behind-${theme}.png`);
      await notice.screenshot({ path });
      console.info(`notice version screenshot: ${path}`);
    }
  }, 30_000);

  it("the state slot is one width whatever word is in it, so a name keeps its room when a word arrives, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      // One row not answering beside a paused one and a gone one: the longest of the state words against the two
      // the fixture already draws.
      await page!.goto(`${base}?theme=${theme}&oom=1`);
      await page!.waitForSelector("[data-sidebar-row]");
      const slots = await page!.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-row-id^='ws:']")).map(row => {
          const slot = row.querySelector<HTMLElement>("[data-workspace-state]")!;
          const name = row.querySelector<HTMLElement>("[data-workspace-name]")!;
          // The word's own width, which is what the slot has to hold: the slot's box is its min-width once it is
          // wider than the text, so the box says nothing about whether the word fits in it.
          const range = document.createRange();
          range.selectNodeContents(slot);
          return { state: slot.textContent ?? "", slotWidth: slot.getBoundingClientRect().width, wordWidth: range.getBoundingClientRect().width, nameWidth: name.getBoundingClientRect().width };
        }),
      );
      console.info(`state slots at ${theme}: ${JSON.stringify(slots)}`);
      // The stopping words: a row reads the pause mode of the computer its project lands on, and this shell is
      // served no landing, so it reads what every computer but a provider with memory pauses does.
      expect(slots.map(s => s.state)).toEqual(["Unreachable", "Stopped", "Gone"]);
      // The slot is one width on every row, so the name beside it is too: the name used to give back 16 px the
      // moment a long word arrived, which moved it under a person reading it.
      expect(new Set(slots.map(s => Math.round(s.slotWidth))).size).toBe(1);
      expect(new Set(slots.map(s => Math.round(s.nameWidth))).size).toBe(1);
      // And the longest word there is is drawn whole in it rather than cut by it.
      for (const slot of slots) expect(slot.wordWidth).toBeLessThanOrEqual(slot.slotWidth);
    }
  }, 30_000);

  it("the line the runtime puts on a machine's row is the whole second line, drawn whole and at the row's own height, in both themes", async () => {
    const metaOf = (): Promise<{ text: string; clipped: boolean; height: number }[]> =>
      page!.locator("[data-row-id^='ws:']").evaluateAll(rows =>
        rows.map(row => {
          const meta = row.querySelector<HTMLElement>("[data-workspace-meta]");
          // textContent is the whole string whatever CSS does to it, so what the person sees is scroll against client.
          return { text: meta?.textContent ?? "", clipped: meta !== null && meta.scrollWidth > meta.clientWidth, height: row.getBoundingClientRect().height, widths: [meta?.clientWidth, meta?.scrollWidth, document.querySelector("[data-slot=sidebar]")!.getBoundingClientRect().width] };
        }),
      );
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const plain = await metaOf();
      // A cloud fork with no copy of a folder has no branch to name: its row is one line at a thread row's height,
      // with no blank second line and never a figure.
      expect(plain[0]!.text).toBe("");
      expect(plain[0]!.height).toBe(36);

      await page!.goto(`${base}?theme=${theme}&helper=1`);
      await page!.waitForSelector("[data-sidebar-row]");
      const updating = await metaOf();
      console.info(`helper line at ${theme}: ${JSON.stringify(updating[0])}`);
      // The whole line, nothing beside it, drawn whole rather than cut, on the second line a row on a branch has.
      // The slot is about 159px at the default width, so a line that outgrows it goes red here.
      expect(updating[0]!.text).toBe("updating the helper");
      expect(updating[0]!.clipped).toBe(false);
      expect(updating[0]!.height).toBe(52);
      expect(updating.slice(1).map(m => m.text)).toEqual(plain.slice(1).map(m => m.text));
      const path = join(SHOTS_DIR, `sidebar-helper-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar helper line screenshot: ${path}`);

      // The same slot when the link dropped after a near-full sample: the row form of the words, whole.
      await page!.goto(`${base}?theme=${theme}&oom=1`);
      await page!.waitForSelector("[data-sidebar-row]");
      const oom = await metaOf();
      expect(oom[0]!.text).toBe("out of memory, 3.6 of 3.9 GB");
      expect(oom[0]!.clipped).toBe(false);
      expect(oom[0]!.height).toBe(52);
      const oomPath = join(SHOTS_DIR, `sidebar-oom-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path: oomPath });
      console.info(`sidebar out-of-memory line screenshot: ${oomPath}`);
    }
  }, 30_000);

  it("a send refusal is one muted mono line, no panel, in a slot that takes room only while it holds one; a paused workspace has no line, its box takes words, and its send button reads Wake and send, in both themes", async () => {
    interface Composer {
      box: Box;
      text: string;
      /** The line's paint, or null when the slot is empty. */
      line: { mono: boolean; background: string; border: string; icons: number; ink: string } | null;
      panels: number;
      send: { label: string | null; title: string | null; box: Box | null; fill: string; ink: string; border: string; opacity: string };
      editable: boolean;
      placeholder: string;
    }
    const composerAt = async (query: string, theme: string, name: string): Promise<Composer> => {
      await page!.goto(`${base}?theme=${theme}&${query}`);
      await page!.waitForSelector("[data-composer-refusal]", { state: "attached" });
      // The transcript is fetched after mount; the line for a lingering turn exists only once it is in.
      await page!.waitForSelector("text=loading transcript", { state: "detached" });
      // The send fades between its held tier and its accent over 150 ms, so a computed style read at mount catches
      // the fade rather than either tier.
      await page!.waitForTimeout(400);
      const read = await page!.locator("[data-chat-composer]").evaluate(el => {
        const line = el.querySelector<HTMLElement>("[data-composer-refusal] [role=status]");
        const s = line === null ? null : getComputedStyle(line);
        const send = el.querySelector<HTMLButtonElement>("[data-chat-composer-actions] button[type=submit]");
        const sendStyle = send === null ? null : getComputedStyle(send);
        const editor = el.querySelector<HTMLElement>("[data-testid=composer-editor]");
        const b = send?.getBoundingClientRect();
        return {
          text: el.querySelector("[data-composer-refusal]")?.textContent ?? "",
          line: s === null || line === null ? null : { mono: /mono/i.test(s.fontFamily), background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderLeftWidth}`, icons: line.getElementsByTagName("svg").length, ink: s.color },
          panels: el.querySelectorAll("[data-composer-banner-surface]").length,
          send: {
            label: send?.getAttribute("aria-label") ?? null,
            title: send?.getAttribute("title") ?? null,
            box: b === undefined ? null : { x: b.x, y: b.y, width: b.width, height: b.height },
            fill: sendStyle?.backgroundColor ?? "",
            ink: sendStyle?.color ?? "",
            border: `${sendStyle?.borderTopWidth} ${sendStyle?.borderTopColor}`,
            opacity: sendStyle?.opacity ?? "",
          },
          editable: editor?.getAttribute("contenteditable") !== "false",
          placeholder: editor?.getAttribute("aria-placeholder") ?? el.querySelector("[data-placeholder]")?.textContent ?? "",
        };
      });
      const path = join(SHOTS_DIR, `composer-${name}-${theme}.png`);
      await page!.locator("[data-chat-composer]").screenshot({ path });
      console.info(`composer ${name} screenshot: ${path}`);
      return { box: await box("[data-slot=composer-shell]"), ...read };
    };
    const sendInBox = (c: Composer) => ({ x: c.send.box!.x - c.box.x, y: c.send.box!.y - c.box.y, width: c.send.box!.width, height: c.send.box!.height });
    // A paused workspace's row carries fewer picks; wide enough that no row wraps, the boxes compare as boxes.
    await page!.setViewportSize({ width: 1600, height: 800 });
    for (const theme of ["dark", "light"] as const) {
      const idle = await composerAt("ws=ws_a", theme, "idle");
      expect(idle.text).toBe("");
      expect(idle.line).toBeNull();
      expect(idle.send.label).toBe("Send message");
      expect(idle.editable).toBe(true);
      const paused = await composerAt("ws=ws_b", theme, "paused");
      const gone = await composerAt("ws=ws_c", theme, "gone");
      const working = await composerAt("ws=ws_a&linger=1", theme, "working");
      // A paused workspace: no sentence anywhere, the box takes words, the same button in the same place says it wakes first.
      expect(paused.text).toBe("");
      expect(paused.line).toBeNull();
      expect(paused.editable).toBe(true);
      expect(paused.placeholder).toBe(idle.placeholder);
      expect(paused.placeholder).not.toMatch(/paus|wake/i);
      expect(paused.send.label).toBe(WAKE_AND_SEND_LABEL);
      expect(paused.send.title).toBe(WAKE_AND_SEND_LABEL);
      // The empty view centres its composer under a heading of the workspace's own words, so boxes are read in the box.
      expect(sendInBox(paused)).toEqual(sendInBox(idle));
      expect([paused.box.width, paused.box.height]).toEqual([idle.box.width, idle.box.height]);
      expect(gone.text).toBe(sendRefusal("gone"));
      expect(working.text).toBe(stillWorkingLine());
      // A send held for a reason is not the accent faded: it wears the held tier, a hairline and the popover fill
      // with the arrow in the ink the line above the box is written in, in the slot the live send stands in. Five
      // testers read a lit arrow over a box that refused them as a screen saying it was ready to send.
      expect(sendInBox(gone)).toEqual(sendInBox(idle));
      expect(gone.send.fill).not.toBe(idle.send.fill);
      expect(gone.send.ink).toBe(gone.line!.ink);
      expect(gone.send.border.startsWith("1px ")).toBe(true);
      expect(gone.send.border).not.toBe(idle.send.border);
      // Not a third of itself and not two thirds: the tier changed, the paint did not thin.
      expect(gone.send.opacity).toBe("1");
      // The live send keeps the accent, which is how a person sees the wait is over: one loud thing, and it is this.
      expect(idle.send.fill).not.toBe("rgba(0, 0, 0, 0)");
      expect(paused.send.fill).toBe(idle.send.fill);
      for (const state of [gone, working]) {
        // The words in mono, painted on nothing: no fill, no border, no icon, no panel anywhere in the composer.
        expect(state.line).toEqual({ mono: true, background: "rgba(0, 0, 0, 0)", border: "0px 0px", icons: 0, ink: expect.any(String) });
        expect(state.panels).toBe(0);
      }
      // The line takes room over the box and leaves the box itself as it is. A running turn's composer is the one
      // line over its transcript, so only the empty view's box is held to the idle one.
      expect([gone.box.width, gone.box.height]).toEqual([idle.box.width, idle.box.height]);
    }
    await page!.setViewportSize({ width: 1200, height: 800 });
  }, 60_000);

  it("a pick closes the option menu, so the click after it lands on the prompt the menu was covering", async () => {
    // A turn running on this computer with a prompt open under the composer, which is the page the menu covered.
    await page!.goto(`${base}?theme=dark&local=1&ws=ws_m&perm=1`);
    await page!.waitForSelector("[data-composer-picker='access']");
    await page!.waitForSelector("text=loading transcript", { state: "detached" });
    await page!.waitForSelector("[data-permission-prompt='ask_open'][data-permission-open='true']");
    await page!.locator("[data-composer-picker='access']").click();
    await page!.waitForSelector("[data-composer-option='plan']");
    // What the pick will do to the turn running now, read over the list before anything is picked.
    expect(await page!.locator("[data-composer-access-reach]").textContent()).toBe(accessReachLine(true));

    await page!.locator("[data-composer-option='plan']").click();
    await page!.waitForSelector(`[data-composer-picker='access'][data-access='plan']`);
    // The menu is gone on the pick: nothing of it is left over the page, visible or not.
    await page!.waitForSelector("[role=menu]", { state: "detached" });

    // Plan says nothing about the write in front of the person, so the prompt stands and their click on it lands
    // rather than being eaten by a menu that stayed up.
    const allow = page!.locator("[data-permission-prompt='ask_open'] [data-permission-option='allow']");
    await allow.click({ timeout: 5_000 });
    await page!.waitForSelector("[data-permission-prompt='ask_open'][data-permission-open='false']");
  }, 60_000);

  it("an access that answers the open prompt closes it without a click, and says nothing about a next message", async () => {
    await page!.goto(`${base}?theme=dark&local=1&ws=ws_m&perm=1`);
    await page!.waitForSelector("[data-composer-picker='access']");
    await page!.waitForSelector("text=loading transcript", { state: "detached" });
    await page!.waitForSelector("[data-permission-prompt='ask_open'][data-permission-open='true']");
    await page!.locator("[data-composer-picker='access']").click();
    await page!.waitForSelector("[data-composer-option='bypassPermissions']");
    await page!.locator("[data-composer-option='bypassPermissions']").click();

    // The prompt the turn was stopped on is answered by the pick itself: the person clicks nothing.
    await page!.waitForSelector("[data-permission-prompt='ask_open'][data-permission-open='false']");
    await page!.waitForSelector(`[data-composer-picker='access'][data-access='bypassPermissions']`);
    expect(await page!.locator("[data-composer-refusal]").textContent()).toBe("");
  }, 60_000);

  it("an access picked while a turn runs reads back on the picker, and a refusal the harness answered with is one uncut muted mono line, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      // A turn running on this computer whose harness takes the change back after its row said it takes it, which is
      // the one thing the composer says in that slot.
      await page!.goto(`${base}?theme=${theme}&local=1&ws=ws_m&perm=1&access=refused`);
      await page!.waitForSelector("[data-composer-picker='access']");
      await page!.waitForSelector("text=loading transcript", { state: "detached" });
      const trigger = "[data-composer-picker='access']";
      // The picker opens on bypass, which is what a thread on this computer starts at.
      expect(await page!.locator(trigger).getAttribute("data-access")).toBe("bypassPermissions");
      const before = await box("[data-slot=composer-shell]");
      await page!.locator(trigger).click();
      await page!.waitForSelector("[data-composer-option='acceptEdits']");
      // The menu says what the pick does before it is made; the refusal below is the harness taking that back.
      expect(await page!.locator("[data-composer-access-reach]").textContent()).toBe(accessReachLine(true));
      const menu = join(SHOTS_DIR, `composer-access-menu-${theme}.png`);
      await page!.locator("[role=menu]").first().screenshot({ path: menu });
      console.info(`composer access menu screenshot: ${menu}`);
      await page!.locator("[data-composer-option='acceptEdits']").click();

      // The pick reads back on the trigger whatever the running turn did with it, and the line says when it lands.
      await page!.waitForSelector(`${trigger}[data-access='acceptEdits']`);
      // The pick closes the menu, so the line is photographed with nothing over it.
      await page!.waitForSelector("[role=menu]", { state: "detached" });
      await page!.waitForSelector("[data-composer-refusal] [role=status]");
      const read = await page!.locator("[data-chat-composer]").evaluate(el => {
        const line = el.querySelector<HTMLElement>("[data-composer-refusal] [role=status]")!;
        const s = getComputedStyle(line);
        const label = el.querySelector<HTMLElement>("[data-composer-picker='access']")!;
        return {
          text: line.textContent ?? "",
          skin: { mono: /mono/i.test(s.fontFamily), background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderLeftWidth}`, icons: line.getElementsByTagName("svg").length },
          // The slot truncates from the right; a line wider than its box loses its own tail.
          cut: line.scrollWidth > line.clientWidth,
          width: line.scrollWidth,
          slot: (line.parentElement as HTMLElement).clientWidth,
          trigger: label.textContent ?? "",
          panels: el.querySelectorAll("[data-composer-banner-surface]").length,
        };
      });
      const shot = join(SHOTS_DIR, `composer-access-${theme}.png`);
      await page!.locator("[data-chat-composer]").screenshot({ path: shot });
      console.info(`composer access line screenshot: ${shot} (${read.width} px of line in ${read.slot} px of slot)`);

      expect(read.text).toBe(ACCESS_REFUSED_LINE);
      expect(read.trigger).toBe("Accept edits");
      // Whole at the width this app is smallest in: the clause that says when the pick lands is the point of it.
      expect(read.cut).toBe(false);
      expect(read.width).toBeLessThan(read.slot);
      // Drawn like every other line in that slot: mono words on nothing, no fill, no border, no icon, no panel.
      expect(read.skin).toEqual({ mono: true, background: "rgba(0, 0, 0, 0)", border: "0px 0px", icons: 0 });
      expect(read.panels).toBe(0);
      // The line moves nothing: the slot is there whether or not a line is in it.
      expect(await box("[data-slot=composer-shell]")).toEqual(before);
    }
  }, 60_000);

  it("the composer's images are a row of square thumbnails above the text, each with its own remove, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a`);
      await page!.waitForSelector("[data-composer-image-picker]");
      const [empty] = await settledBoxes(["[data-chat-composer]"]);
      // The picker sits with the send at the right, first, before the send.
      const order = await page!.locator("[data-chat-composer-actions]").evaluate(el =>
        [...el.querySelectorAll("button")].map(b => (b.hasAttribute("data-composer-image-picker") ? "picker" : b.getAttribute("type") === "submit" ? "send" : "?")),
      );
      expect(order).toEqual(["picker", "send"]);
      expect(await page!.locator("[data-composer-images]").count()).toBe(0);

      await page!.goto(`${base}?theme=${theme}&ws=ws_a&images=3`);
      await page!.waitForSelector("[data-composer-images] [data-chat-image]");
      await page!.waitForFunction(() => document.querySelectorAll("[data-composer-images] [data-chat-image]").length === 3);
      const thumbs = await page!.locator("[data-composer-images] [data-chat-image]").evaluateAll(els =>
        els.map(el => {
          const r = el.getBoundingClientRect();
          const button = el.querySelector("button")!;
          const s = getComputedStyle(button);
          return { width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top), radius: s.borderTopLeftRadius, removes: el.querySelectorAll("[aria-label^=Remove]").length };
        }),
      );
      expect(thumbs).toHaveLength(3);
      // One square per image, all on one line, each with its own remove: a uniform row, not three shapes.
      expect(new Set(thumbs.map(t => `${t.width}x${t.height}`)).size).toBe(1);
      expect(thumbs[0]!.width).toBe(thumbs[0]!.height);
      expect(new Set(thumbs.map(t => t.top)).size).toBe(1);
      expect(new Set(thumbs.map(t => t.radius)).size).toBe(1);
      expect(thumbs.map(t => t.removes)).toEqual([1, 1, 1]);
      // The row is above the text, inside the box, and the box grew by the row rather than the row escaping it.
      const [row, editor, shell, grown] = await settledBoxes(["[data-composer-images]", "[data-chat-composer-form] [contenteditable]", "[data-slot=composer-shell]", "[data-chat-composer]"]);
      expect(row.y + row.height).toBeLessThanOrEqual(editor.y);
      expect(row.y).toBeGreaterThan(shell.y);
      expect(row.x + row.width).toBeLessThanOrEqual(shell.x + shell.width);
      expect(grown.height).toBeGreaterThan(empty.height);
      const path = join(SHOTS_DIR, `composer-images-${theme}.png`);
      await page!.locator("[data-chat-composer]").screenshot({ path });
      console.info(`composer images screenshot: ${path}`);
    }
  }, 60_000);

  it("the composer's model picker carries the agent's bare mark on its button and one per agent on its rail, in both themes", async () => {
    interface MarkRead {
      harness: string | null;
      size: number[];
      /** The mark's centre against its neighbour's centre. */
      offset: number;
      color: string;
      bare: boolean;
    }
    const readMarks = (selector: string): Promise<MarkRead[]> =>
      page!.locator(selector).evaluateAll(els =>
        els.map(el => {
          const box = el.getBoundingClientRect();
          const beside = (el.nextElementSibling ?? el.parentElement!).getBoundingClientRect();
          const s = getComputedStyle(el);
          return {
            harness: el.getAttribute("data-harness-mark"),
            size: [box.width, box.height],
            offset: box.y + box.height / 2 - (beside.y + beside.height / 2),
            color: s.color,
            bare: s.backgroundColor === "rgba(0, 0, 0, 0)" && s.borderTopWidth === "0px" && s.boxShadow === "none",
          };
        }),
      );
    const expectBare = (marks: MarkRead[], low = 13, high = 16) => {
      for (const mark of marks) {
        for (const side of mark.size) {
          expect(side).toBeGreaterThanOrEqual(low);
          expect(side).toBeLessThanOrEqual(high);
        }
        expect(Math.abs(mark.offset)).toBeLessThan(1.5);
        expect(mark.bare).toBe(true);
      }
    };
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a`);
      await page!.waitForSelector("[data-composer-picker='model'] svg[data-harness-mark]");
      const [trigger] = await readMarks("[data-composer-picker='model'] svg[data-harness-mark]");
      expect(trigger!.harness).toBe("claude");
      expectBare([trigger!]);
      expect(trigger!.color).not.toBe(await page!.locator("[data-composer-picker='model']").evaluate(el => getComputedStyle(el).color));
      await page!.locator("[data-composer-picker='model']").click();
      await page!.waitForSelector("[data-composer-model-menu]");
      // The popup fades and scales in; the shot waits for it to be drawn whole and on the page.
      await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-slot=popover-popup]")!).opacity === "1");
      await page!.waitForTimeout(300);
      const popup = await box("[data-slot=popover-popup]");
      expect(popup.width).toBeGreaterThan(200);
      expect(popup.y).toBeGreaterThanOrEqual(0);
      const rail = await readMarks("[data-composer-harness] svg[data-harness-mark]");
      console.info(`picker marks at ${theme}: ${JSON.stringify({ trigger, rail })}`);
      expect(rail.map(m => m.harness)).toEqual(["claude", "codex"]);
      // The rail's tabs are square buttons of their own, so their marks stand a step larger than the button's.
      expectBare(rail, 20, 20);
      expect(rail[0]!.color).toBe(trigger!.color);
      expect(rail[1]!.color).not.toBe(rail[0]!.color);
      const path = join(SHOTS_DIR, `composer-picker-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`composer picker screenshot: ${path}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-composer-model-menu]", { state: "detached" });
    }
  }, 60_000);

  it("the effort picker marks the default of the model picked, not of the agent, in both themes", async () => {
    const read = async (): Promise<{ label: string; marked: string[]; checked: string[]; badge: { mono: boolean; bare: boolean; muted: boolean } }> => {
      const label = await page!.locator("[data-composer-picker='reasoning']").evaluate(el => el.textContent ?? "");
      return page!.locator("[data-slot=menu-popup] [data-composer-option]").evaluateAll(
        (els, buttonLabel) => {
          const badgeOf = (el: Element) => [...el.querySelectorAll("span")].find(s => s.textContent === "default");
          const marked = els.filter(el => badgeOf(el) !== undefined).map(el => el.getAttribute("data-composer-option") ?? "");
          const badge = badgeOf(els.find(el => badgeOf(el) !== undefined)!)!;
          const s = getComputedStyle(badge);
          const row = getComputedStyle(els[0]!);
          return {
            label: buttonLabel,
            marked,
            checked: els.filter(el => el.getAttribute("aria-checked") === "true").map(el => el.getAttribute("data-composer-option") ?? ""),
            badge: { mono: s.fontFamily.toLowerCase().includes("mono"), bare: s.boxShadow === "none", muted: s.color !== row.color },
          };
        },
        label,
      );
    };
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a`);
      await page!.waitForSelector("[data-composer-picker='model']");
      await page!.locator("[data-composer-picker='model']").click();
      await page!.waitForSelector("[data-composer-model-menu]");
      await page!.locator("[data-composer-harness='codex']").click();
      await page!.waitForSelector("[data-composer-picker='reasoning'][data-effort='low']");
      await page!.locator("[data-composer-picker='reasoning']").click();
      await page!.waitForSelector("[data-slot=menu-popup] [data-composer-option='medium']");
      const sol = await read();
      await page!.keyboard.press("Escape");
      await page!.locator("[data-composer-picker='model']").click();
      await page!.locator("[data-composer-option='gpt-5.5']").click();
      await page!.waitForSelector("[data-composer-picker='reasoning'][data-effort='medium']");
      await page!.locator("[data-composer-picker='reasoning']").click();
      await page!.waitForSelector("[data-slot=menu-popup] [data-composer-option='medium']");
      const picked = await read();
      console.info(`effort default at ${theme}: ${JSON.stringify({ sol, picked })}`);
      // The app-server reports low for GPT-5.6-Sol and medium for GPT-5.5, so the mark moves with the pick.
      expect(sol.label).toBe("Low");
      expect(sol.marked).toEqual(["low"]);
      expect(sol.checked).toEqual(["low"]);
      expect(picked.label).toBe("Medium");
      expect(picked.marked).toEqual(["medium"]);
      expect(picked.checked).toEqual(["medium"]);
      // The word is muted mono on nothing, the same caption the model menu marks its default with.
      expect(picked.badge).toEqual({ mono: true, bare: true, muted: true });
      const path = join(SHOTS_DIR, `composer-effort-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`composer effort screenshot: ${path}`);
      await page!.keyboard.press("Escape");
    }
  }, 60_000);

  it("collapsing the sidebar puts the page header's toggle where the sidebar's was, and the breadcrumb after it, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      // A workspace opens on its composer; the crumb names a thread once one is open.
      await page!.locator("[data-row-id='thread:s2']").click();
      await page!.waitForSelector("header [data-breadcrumb-thread]");
      const before = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger]");
      expect(await page!.locator("header [data-slot=sidebar-trigger]").count()).toBe(0);
      await page!.locator("[data-slot=sidebar-header] [data-slot=sidebar-trigger]").click();
      await page!.waitForSelector("[data-sidebar-state=collapsed]");
      // The row animates padding-left over 200 ms; the read waits for the toggle to land.
      await page!.waitForFunction(x => Math.abs(document.querySelector("header [data-slot=sidebar-trigger]")!.getBoundingClientRect().x - x) < 1, before.x);
      const after = await box("header [data-slot=sidebar-trigger]");
      expect(Math.abs(after.x - before.x)).toBeLessThan(1);
      expect(Math.abs(after.y - before.y)).toBeLessThan(1);
      const crumb = await box("header [data-thread-breadcrumb]");
      expect(Math.abs(crumb.x - (after.x + after.width + (await rowGap("header [data-header-row]"))))).toBeLessThan(1);
      expect(await page!.locator("header [data-thread-breadcrumb]").evaluate(el => el.textContent)).toBe("api/Reply with exactly the word hi.");
      const ratios = await textContrast(page!, "header [data-thread-breadcrumb] .text-muted-foreground");
      for (const ratio of ratios) expect(ratio, `the collapsed header's quiet crumb reads at ${ratio} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      const path = join(SHOTS_DIR, `header-collapsed-${theme}.png`);
      await page!.screenshot({ path, clip: { x: 0, y: 0, width: 600, height: 120 } });
      console.info(`collapsed header screenshot: ${path}`);
    }
  }, 60_000);
  /** One row's name slot: the row's height, where the name starts, where the slot at the right edge ends, and the
   * name's own font, read the same way whether the slot holds the text or the one name box. `selector` picks the row
   * and `nameSelector` the text it wears, so a workspace row and a thread row are read by the same rule. */
  const nameSlot = async (
    selector: string,
    nameSelector: string,
  ): Promise<{ rowHeight: number; nameX: number; slotRight: number; font: string; size: string; text: string; value: string; focused: boolean }> =>
    page!.locator(selector).first().evaluate((row: HTMLElement, of: string) => {
      const input = row.querySelector<HTMLInputElement>("[data-row-name-input]");
      const name = input ?? row.querySelector<HTMLElement>(of)!;
      const slot = row.querySelector<HTMLElement>(`${of} ~ span, [data-row-name-input] ~ span`)!;
      const s = getComputedStyle(name);
      return {
        rowHeight: row.getBoundingClientRect().height,
        nameX: name.getBoundingClientRect().x,
        slotRight: slot.getBoundingClientRect().right,
        font: s.fontFamily,
        size: s.fontSize,
        text: name.textContent ?? "",
        value: input?.value ?? "",
        focused: document.activeElement === input,
      };
    }, nameSelector);
  const titleSlot = () => nameSlot("[data-row-id^='thread:']", "[data-thread-title]");

  it("a right-click on a workspace row opens the in-app menu at the pointer in the tooltip skin, kept inside the viewport, and Escape closes it, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const row = await box("[data-row-id='ws:ws_a']");
      // On the row's hover buttons too: the whole row is the workspace's.
      const at = { x: row.x + row.width - 12, y: row.y + row.height / 2 };
      await page!.mouse.click(at.x, at.y, { button: "right" });
      await page!.waitForSelector("[data-context-menu]");
      const menu = await box("[data-context-menu]");
      expect(Math.abs(menu.x - at.x)).toBeLessThan(1);
      expect(Math.abs(menu.y - at.y)).toBeLessThan(1);
      const viewport = page!.viewportSize()!;
      expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width - 8);
      expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height - 8);
      const skin = await page!.locator("[data-context-menu]").evaluate(el => {
        const s = getComputedStyle(el);
        return { border: s.borderTopWidth, background: s.backgroundColor, radius: s.borderTopLeftRadius, z: s.zIndex, arrows: el.querySelectorAll("[data-arrow], svg").length };
      });
      expect(skin.border).toBe("1px");
      expect(skin.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(skin.z).toBe("130");
      expect(skin.arrows).toBe(0);
      expect(await page!.locator("[data-context-menu] [role=menuitem]").count()).toBe(10);
      // Bring back, export (this fake host has no folder ops), run a copy and delete.
      expect(await page!.locator("[data-context-menu] [role=menuitem][aria-disabled=true]").count()).toBe(4);
      // The first row that can run holds focus, so the keyboard is already in the menu.
      expect(await page!.locator("[data-context-menu] [role=menuitem]").first().evaluate(el => document.activeElement === el)).toBe(true);
      const path = join(SHOTS_DIR, `sidebar-context-menu-${theme}.png`);
      await page!.screenshot({ path, clip: { x: 0, y: 0, width: 520, height: 520 } });
      console.info(`sidebar context menu screenshot: ${path}`);
      // The refusal rides the tooltip skin: hovering a dimmed row shows it.
      await page!.locator("[data-context-menu] [role=menuitem][aria-disabled=true]").first().hover();
      await page!.waitForSelector("[data-slot=tooltip-popup]");
      // Bring back is the first held row: this fake host carries no bring back.
      expect(await page!.locator("[data-slot=tooltip-popup]").textContent()).toBe(WHERE_WORDS.notYet);
      const tipPath = join(SHOTS_DIR, `sidebar-context-menu-refusal-${theme}.png`);
      await page!.screenshot({ path: tipPath, clip: { x: 0, y: 0, width: 640, height: 520 } });
      console.info(`sidebar context menu refusal screenshot: ${tipPath}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-context-menu]", { state: "detached" });
      // Focus goes back where it was: the row's own button under the pointer, which Chromium focused on the press.
      expect(await page!.evaluate(() => document.activeElement?.closest("[data-sidebar='menu-item']")?.querySelector("[data-row-id='ws:ws_a']") !== null)).toBe(true);
      const thread = await box("[data-row-id^='thread:']");
      await page!.mouse.click(thread.x + 20, thread.y + thread.height / 2, { button: "right" });
      await page!.waitForSelector("[data-context-menu]");
      expect(await page!.locator("[data-context-menu] [role=menuitem]").count()).toBe(4);
      await page!.screenshot({ path: join(SHOTS_DIR, `thread-context-menu-${theme}.png`), clip: { x: 0, y: 0, width: 520, height: 520 } });
      console.info(`thread context menu screenshot: ${join(SHOTS_DIR, `thread-context-menu-${theme}.png`)}`);

      // Rename turns that row's title into a field in the same slot: the row keeps its height and the time column
      // keeps its place, and the field wears the title's own font and size.
      const titled = await titleSlot();
      await page!.locator("[data-context-menu] [role=menuitem]", { hasText: "Rename thread" }).click();
      await page!.waitForSelector("[data-row-name-input]");
      const named = await titleSlot();
      expect(named.rowHeight).toBe(titled.rowHeight);
      expect(named.nameX).toBe(titled.nameX);
      expect(named.slotRight).toBe(titled.slotRight);
      expect(named.font).toBe(titled.font);
      expect(named.size).toBe(titled.size);
      expect(named.value).toBe(titled.text);
      expect(named.focused).toBe(true);
      // The name a person types: the selection goes, the field keeps the row's height and the time column's place.
      await page!.keyboard.type("the name he typed");
      const typed = await titleSlot();
      expect(typed.value).toBe("the name he typed");
      expect(typed.rowHeight).toBe(titled.rowHeight);
      expect(typed.slotRight).toBe(titled.slotRight);
      const namePath = join(SHOTS_DIR, `thread-row-renaming-${theme}.png`);
      await page!.screenshot({ path: namePath, clip: { x: 0, y: 0, width: 520, height: 300 } });
      console.info(`thread row renaming screenshot: ${namePath}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-row-name-input]", { state: "detached" });
      expect((await titleSlot()).text).toBe(titled.text);
      await page!.waitForSelector("[data-context-menu]", { state: "detached" });
    }
  }, 60_000);

  it("Rename turns a workspace row's name into the same field in the same slot, from the menu and from a double-click, in both themes", async () => {
    const wsSlot = () => nameSlot("[data-row-id='ws:ws_a']", "[data-workspace-name]");
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const plain = await wsSlot();
      const row = await box("[data-row-id='ws:ws_a']");
      await page!.mouse.click(row.x + 40, row.y + row.height / 4, { button: "right" });
      await page!.waitForSelector("[data-context-menu]");
      await page!.locator("[data-context-menu] [role=menuitem]", { hasText: "Rename task" }).click();
      await page!.waitForSelector("[data-row-name-input]");

      // The field takes the name's place: the row keeps its height, the name starts where it started, the state slot
      // at the right edge keeps its place, and the field wears the name's own font and size.
      const named = await wsSlot();
      expect(named.rowHeight).toBe(plain.rowHeight);
      expect(named.nameX).toBe(plain.nameX);
      expect(named.slotRight).toBe(plain.slotRight);
      expect(named.font).toBe(plain.font);
      expect(named.size).toBe(plain.size);
      expect(named.value).toBe(plain.text);
      expect(named.focused).toBe(true);
      await page!.keyboard.type("the name he typed");
      const typed = await wsSlot();
      expect(typed.value).toBe("the name he typed");
      expect(typed.rowHeight).toBe(plain.rowHeight);
      expect(typed.slotRight).toBe(plain.slotRight);
      const path = join(SHOTS_DIR, `workspace-row-renaming-${theme}.png`);
      await page!.screenshot({ path, clip: { x: 0, y: 0, width: 520, height: 300 } });
      console.info(`workspace row renaming screenshot: ${path}`);

      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-row-name-input]", { state: "detached" });
      expect((await wsSlot()).text).toBe(plain.text);

      // A double-click on the name opens the same box, and Enter names the workspace: the row reads the new name.
      await page!.locator("[data-row-id='ws:ws_a'] [data-workspace-name]").dblclick();
      await page!.waitForSelector("[data-row-name-input]");
      await page!.keyboard.type("the name he typed");
      await page!.keyboard.press("Enter");
      await page!.waitForSelector("[data-row-name-input]", { state: "detached" });
      expect((await wsSlot()).text).toBe("the name he typed");
      expect((await wsSlot()).rowHeight).toBe(plain.rowHeight);
    }
  }, 60_000);

  // The sidebar paints its quiet text in four tiers, three of them at part opacity. An alpha buys
  // less contrast over a light surface than over a dark one, so the two themes have to be measured
  // against each other and not only against a floor: with one light token behind them the tiers
  // read 4.62, 4.47, 2.68 and 2.10 to 1 where the dark side's read 8.33, 5.43, 4.35 and 3.00.
  // A sentence drawn in the whisper tier is not a branch: the offline line is one, and so are the line
  // for what the runtime is doing to a daemon and the one for a drop with memory near full. They take
  // the prose ink, which clears AA on both surfaces, while the branch a row's meta line carries keeps
  // the whisper, and a row whose copy has no branch has no meta line at all.
  it("a sentence in a row's meta line takes the prose ink and reads at AA in both themes, and the branch beside it keeps the whisper", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&offline=1`);
      await page!.waitForSelector("[data-sidebar-offline]");
      // The one row on a branch draws the line, and the branchless rows draw none.
      const metaLines = await page!.locator("[data-app-sidebar] [data-row-id^='ws:']").evaluateAll(rows => rows.map(row => [row.getAttribute("data-row-id"), row.querySelector("[data-workspace-meta]")?.textContent ?? null]));
      expect(metaLines).toEqual([["ws:ws_a", null], ["ws:ws_b", "lockfile-bump"], ["ws:ws_c", null]]);
      const prose = await textContrast(page!, "[data-sidebar-offline]");
      const branches = await textContrast(page!, "[data-app-sidebar] [data-workspace-meta]");
      console.info(`${theme}: the offline sentence reads at ${prose.map(r => r.toFixed(2)).join(", ")}, the branch beside it at ${branches.map(r => r.toFixed(2)).join(", ")} to 1`);
      expect(prose.length).toBeGreaterThan(0);
      for (const ratio of prose) expect(ratio, `the offline sentence reads at ${ratio} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      // The branch stays the whisper it was: this raises the sentences, not the tier.
      expect(branches.length).toBe(1);
      for (const ratio of branches) expect(ratio, `the branch reads at ${ratio} in ${theme}`).toBeLessThan(4.5);
    }
  }, 60_000);

  it("the sidebar's ink reads the same in light as in dark: the two tiers that carry words at AA, the whispered ones on the dark side's ink", async () => {
    const TIERS = {
      "a thread's title once it is idle": "[data-app-sidebar] .text-sidebar-muted-foreground",
      "the word on a row at rest": "[data-app-sidebar] [data-slot=sidebar-menu-button]:not([data-active=true])",
      "the state word beside a thread": "[data-sidebar-row] [data-thread-state]",
      "the row's meta line": "[data-app-sidebar] .text-\\[var\\(--top-row-meta\\)\\]",
    } as const;
    // The first three carry words a person reads, so their bar is AA. The last is the whisper the
    // rows are designed around and sits under AA in both themes on purpose, so its bar is the ink
    // its dark twin already ships: it is the tier an alpha over a light surface loses.
    const AT_AA = ["a thread's title once it is idle", "the word on a row at rest", "the state word beside a thread"];
    const read: Record<"dark" | "light", Record<string, number>> = { dark: {}, light: {} };
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      for (const [tier, selector] of Object.entries(TIERS)) {
        const ratios = await textContrast(page!, selector);
        expect(ratios.length, `${tier} drew nothing to measure in ${theme}`).toBeGreaterThan(0);
        read[theme][tier] = Math.min(...ratios);
      }
      console.info(`${theme}: ${Object.entries(read[theme]).map(([tier, ratio]) => `${tier} ${ratio.toFixed(2)}`).join(", ")} to 1`);
    }
    for (const tier of Object.keys(TIERS)) {
      if (AT_AA.includes(tier)) expect(read.light[tier], `${tier} reads at ${read.light[tier]} in light`).toBeGreaterThanOrEqual(4.5);
      else expect(read.light[tier], `${tier} reads at ${read.light[tier]} in light against ${read.dark[tier]} in dark`).toBeGreaterThanOrEqual(read.dark[tier]! - 0.2);
    }
  }, 60_000);
});
