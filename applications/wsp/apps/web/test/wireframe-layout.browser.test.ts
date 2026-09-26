// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar of the four nouns in a real Chromium, on the wireframe page's
// fixed store: every one-line row (search, head, project, thread, leaf) is 36
// px, every fold 28 and every two-line row (workspace, creation) 52 at three sidebar
// widths and in the 390 px sheet; every row ends at one right edge; nothing in
// the sidebar wears caps or letter-spacing; the head sits in the fixed header
// over the scrolling tree; each child list's rail runs the height of its item
// and stops at the tick on the last one; the state words read at AA on a flat
// row and on the lifted row; the one lifted row stands off the ground on both
// sides, on light by a darker fill with a hairline edge; a project row's plus
// is nothing at rest and there on hover, and on the phone's sheet every hover
// glyph is nothing at rest and no tap target but the selected workspace row's
// chevron, which takes its tap; every row fades its fill and ink in 150 ms;
// the leaf under an empty project is a
// sentence in the sans; the held compose glyph still answers a hover with its
// tooltip; the switcher's menu is the head's width, its rows 36 px, at rest
// with no transform once open; the desktop foot names this computer; and the
// whole is photographed on every screen in both themes for a judge. The
// settings page follows, on the same page: every row 64 px and every line 44,
// the settings sidebar's rows 36 with one lifted, at 390 a card whose rows
// hold a value standing them at 96 with the slot under the description and
// every other card at 72, every line 56 with its right side under its label,
// a row of chips growing until no chip is cut at either width, no label,
// word, sentence or value cut or spilling its box at that width, no caps but
// the small mono labels, no cut segment, no sideways scroll, the muted words
// at AA, a held control further down the opacity ramp than a live one, no group row lifted
// while the results stand and a dimmed row standing back by opacity on both
// sides, the sub-rows holding their room so picking a group moves no row below
// it, the Light pick drawing the page light, Restore defaults only off the
// defaults, the region right of the sidebar whole with the panel back on the
// chord, and Add a computer's roads laid out on Computers. A computer's page
// is photographed to its foot at both widths, in a window tall enough to hold
// it, since its acts are under its agent rows. Vite serves test/wireframe to Playwright's
// browser, so like the shell layout test it runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium on the machine.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { DEFAULT_PREFERENCES, PlaceAddStep } from "@wsp/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast, wcagContrast } from "./contrast";
import { MICRO_LABEL } from "../src/lib/microLabel";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
const THEMES = ["dark", "light"] as const;
const WIDTHS = [220, 256, 480] as const;
const ONE_LINE = 36;
const TWO_LINE = 52;
/** A fold is a label over rows rather than a row of its own, so it stands shorter than one. */
const FOLD = 28;

/** Every row of the sidebar by what it is, with its box and the box of the slot at its right edge. */
interface RowRead {
  id: string;
  kind: "one" | "two" | "fold";
  height: number;
  left: number;
  right: number;
  slotRight: number | null;
}

if (renderSkipped !== undefined) console.info(`wireframe layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the sidebar of the four nouns laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    base = `${vite.base}/test/wireframe/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Each case starts the page as a first visit: a pick one case stored is not the next one's.
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  const url = (screen: string, theme: (typeof THEMES)[number], extra = ""): string => `${base}?screen=${screen}&theme=${theme}${extra}`;
  const open = async (screen: string, theme: (typeof THEMES)[number], extra = "", waitFor = "[data-sidebar-row]"): Promise<void> => {
    await page!.setViewportSize({ width: 1280, height: 800 });
    await page!.goto(url(screen, theme, extra));
    await page!.waitForSelector(waitFor);
  };
  const shot = async (name: string, selector?: string): Promise<string> => {
    const path = join(SHOTS_DIR, `wireframe-${name}.png`);
    if (selector === undefined) await page!.screenshot({ path });
    else await page!.locator(selector).first().screenshot({ path });
    console.info(`wireframe screenshot: ${path}`);
    return path;
  };

  /** Every row in the sidebar's tree and its fixed header, read once. */
  const rows = (): Promise<RowRead[]> =>
    page!.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-search-row], [data-slot=sidebar] [data-k=project-switcher], [data-slot=sidebar] [data-sidebar-row], [data-slot=sidebar] [data-k=no-workspaces], [data-slot=sidebar] [data-thread-launch], [data-slot=sidebar] [data-k=new-project]")];
      return els.map(el => {
        const id = el.dataset["rowId"] ?? el.dataset["k"] ?? (el.hasAttribute("data-search-row") ? "search" : el.hasAttribute("data-thread-launch") ? "launch" : "?");
        const box = el.getBoundingClientRect();
        const slot = el.querySelector<HTMLElement>("[data-thread-state], [data-thread-time], [data-workspace-state], [data-project-slot], [data-creation-state]");
        // A row says how many lines it has: a workspace on a branch or a creation is two, everything else one.
        return { id, kind: el.dataset["lines"] === "2" ? "two" : el.querySelector("[data-group-word]") !== null ? "fold" : "one", height: box.height, left: box.left, right: box.right, slotRight: slot === null ? null : slot.getBoundingClientRect().right } as const;
      });
    });

  const expectOneGrammar = (read: RowRead[], where: string): void => {
    expect(read.length, where).toBeGreaterThan(2);
    for (const row of read) expect(row.height, `${row.id} at ${where}`).toBe(row.kind === "two" ? TWO_LINE : row.kind === "fold" ? FOLD : ONE_LINE);
    // Every row ends at one x whatever its depth: the tree takes its room from the left alone.
    const rights = new Set(read.filter(row => row.id !== "search" && row.id !== "project-switcher").map(row => Math.round(row.right)));
    expect([...rights], `right edges at ${where}`).toHaveLength(1);
    const slots = new Set(read.flatMap(row => (row.slotRight === null ? [] : [Math.round(row.slotRight)])));
    expect(slots.size, `slot edges at ${where}`).toBeLessThanOrEqual(1);
  };

  it("every one-line row is 36 px, every fold 28 and every two-line row 52 at 220, 256 and 480, every row and every slot ending at one x, in both themes", async () => {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        await open("sidebar", theme, `&sidebar=${width}`);
        const sidebar = await page!.locator("[data-slot=sidebar]").first().boundingBox();
        expect(Math.round(sidebar!.width)).toBe(width);
        const read = await rows();
        console.info(`rows at ${width} ${theme}: ${JSON.stringify(read.map(r => [r.id, r.height, Math.round(r.left)]))}`);
        expectOneGrammar(read, `${width} ${theme}`);
        // The computer word beside a project on the box ends where every other slot ends, not short of the plus's room.
        const computerRight = await page!.locator("[data-row-id='project:pr_landing'] [data-project-computer]").evaluate(el => el.getBoundingClientRect().right);
        expect(Math.round(computerRight), `the computer word at ${width} ${theme}`).toBe(Math.round(read.find(row => row.id === "thread:th_lead")!.slotRight!));
        // The depth reads in the left edge: 16 px a level.
        const at = (id: string) => read.find(row => row.id === id)!.left;
        expect(Math.round(at("ws:ws_copy") - at("project:pr_spoo"))).toBe(16);
        expect(Math.round(at("thread:th_lead") - at("ws:ws_copy"))).toBe(16);
        expect(Math.round(at("thread:th_build") - at("thread:th_lead"))).toBe(16);
        expect(Math.round(at("thread:th_review") - at("thread:th_build"))).toBe(16);
        expect(Math.round(at("ws:ws_fork") - at("thread:th_lead"))).toBe(16);
        await shot(`sidebar-${width}-${theme}`, "[data-slot=sidebar]");
      }
      await open("sidebar", theme);
      await shot(`sidebar-1280-${theme}`);
    }
  }, 120_000);

  it("under one picked project the tree starts at its workspaces one level out, the head names the project, and the lifted row is the one selected three deep, in both themes", async () => {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        await open("sidebar-picked", theme, `&sidebar=${width}&pick=pr_spoo`, "[data-sidebar-row][data-active=true]");
        const read = await rows();
        expectOneGrammar(read, `picked ${width} ${theme}`);
        expect(read.some(row => row.id.startsWith("project:"))).toBe(false);
        expect(await page!.locator("[data-k=project-switcher] [data-switcher-name]").textContent()).toBe("spoo");
        const lifted = await page!.locator("[data-sidebar-row][data-active=true]").evaluateAll(els => els.map(el => [el.dataset["rowId"], el.dataset["depth"]]));
        expect(lifted).toEqual([["thread:th_review", "3"]]);
        // The head carries the plus while it stands in for the project's row, at nothing until hovered, and in the
        // room the head keeps for it before the chevron.
        expect(await page!.locator("[data-sidebar-search] [data-k=new-workspace]").evaluate(el => getComputedStyle(el).opacity)).toBe("0");
        const plusBox = await page!.locator("[data-sidebar-search] [data-k=new-workspace]").boundingBox();
        const roomBox = await page!.locator("[data-sidebar-search] [data-switcher-plus-room]").boundingBox();
        expect(Math.abs(plusBox!.x - roomBox!.x), `the head's plus at ${width} ${theme}`).toBeLessThan(1);
        expect(Math.abs(plusBox!.width - roomBox!.width)).toBeLessThan(1);
        await shot(`sidebar-picked-${width}-${theme}`, "[data-slot=sidebar]");
      }
      await open("sidebar-picked", theme, "&pick=pr_spoo", "[data-sidebar-row][data-active=true]");
      await shot(`sidebar-picked-1280-${theme}`);
    }
  }, 120_000);

  it("the empty wsp holds the head, held, and one row pointing at the first run; one project alone still sits under All projects, in both themes", async () => {
    for (const theme of THEMES) {
      await open("sidebar-empty", theme, "", "[data-k=new-project]");
      const empty = await rows();
      expectOneGrammar(empty, `empty ${theme}`);
      expect(empty.map(row => row.id)).toEqual(["search", "project-switcher", "new-project"]);
      expect(await page!.locator("[data-k=project-switcher]").isDisabled()).toBe(true);
      expect(await page!.locator("[data-slot=sidebar] button[aria-label='New thread']").isDisabled()).toBe(true);
      expect(await page!.locator("[data-k=first-run]").count()).toBe(1);
      expect(await page!.locator("[data-slot=sidebar]").first().textContent()).not.toMatch(/No projects yet|A project is a folder|Add a project/);
      await shot(`sidebar-empty-1280-${theme}`);
      // The held compose glyph still takes the pointer, so its tooltip can say what it is in the one state a
      // person might ask why it is held.
      await page!.locator("[data-slot=sidebar] button[aria-label='New thread']").hover();
      await page!.waitForSelector("[data-slot=tooltip-popup]");
      expect(await page!.locator("[data-slot=tooltip-popup]").textContent()).toMatch(/^New thread/);
      await page!.mouse.move(640, 400);

      await open("sidebar-one-project", theme);
      const one = await rows();
      expectOneGrammar(one, `one project ${theme}`);
      expect(one.filter(row => row.id.startsWith("project:")).map(row => row.id)).toEqual(["project:pr_spoo"]);
      expect(await page!.locator("[data-k=project-switcher] [data-switcher-name]").textContent()).toBe("All projects");
      await shot(`sidebar-one-project-1280-${theme}`);
    }
  }, 90_000);

  it("the leaf under a project with no workspace is a sentence in the sans at the rows' size, not the mono the figures wear", async () => {
    await open("sidebar", "dark");
    const faces = await page!.evaluate(() => {
      const face = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return { family: style.fontFamily, size: style.fontSize };
      };
      return { leaf: face("[data-k=no-workspaces]"), name: face("[data-row-id='project:pr_wsp'] [data-project-name]"), branch: face("[data-row-id='ws:ws_copy'] [data-workspace-meta]") };
    });
    expect(faces.leaf.family).toBe(faces.name.family);
    expect(faces.leaf.family).not.toBe(faces.branch.family);
    expect(faces.leaf.size).toBe("13px");
  }, 30_000);

  it("every row fades its fill and its ink in 150 ms on hover, and a fold, which takes no fill, its words", async () => {
    await open("sidebar", "dark");
    const read = await rows();
    const fades = await page!.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-search-row], [data-slot=sidebar] [data-k=project-switcher], [data-slot=sidebar] [data-sidebar-row]")];
      return els.map(el => {
        const faded = el.querySelector<HTMLElement>("[data-group-word]") ?? el;
        return { id: el.dataset["rowId"] ?? el.dataset["k"] ?? "search", fold: faded !== el, property: getComputedStyle(faded).transitionProperty, duration: getComputedStyle(faded).transitionDuration };
      });
    });
    expect(fades.length).toBe(read.length - 1);
    for (const fade of fades) {
      if (fade.fold) expect(fade.property.split(", "), fade.id).toContain("color");
      else expect(fade.property, fade.id).toBe("background-color, color");
      expect(fade.duration, fade.id).toBe("0.15s");
    }
    // The kinds this screen has: the search row, the head, a project, a workspace, a thread and a fold.
    expect(fades.some(f => f.id.startsWith("ws:"))).toBe(true);
    expect(fades.some(f => f.id.startsWith("thread:"))).toBe(true);
    expect(fades.some(f => f.id.startsWith("archived:"))).toBe(true);
  }, 30_000);

  it("the one lifted row stands off the ground on both sides: on light a fill one step darker with a hairline edge at 1.2 to 1 or better, on dark the fill alone", async () => {
    for (const theme of THEMES) {
      await open("sidebar-picked", theme, "&pick=pr_spoo", "[data-sidebar-row][data-active=true]");
      // The fill fades in over 150 ms once the row is selected; it is read once it has landed.
      await page!.waitForTimeout(400);
      const lifted = await page!.evaluate(() => {
        const ctx = document.createElement("canvas").getContext("2d")!;
        const parse = (c: string): number[] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return [r!, g!, b!, a! / 255];
        };
        const over = (top: number[], under: number[]): number[] => [0, 1, 2].map(i => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
        const row = document.querySelector<HTMLElement>("[data-sidebar-row][data-active=true]")!;
        const layers: number[][] = [];
        for (let n: Element | null = row.parentElement; n !== null && layers.at(-1)?.[3] !== 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c[3]! > 0) layers.push(c);
        }
        const ground = layers.reverse().reduce((below, top) => over(top, below), [255, 255, 255]);
        const fill = over(parse(getComputedStyle(row).backgroundColor), ground);
        // The edge is the inset layer of the row's box shadow, painted over its fill; its colour leads the layer.
        const shadow = getComputedStyle(row).boxShadow;
        const inset = shadow.split(/,\s(?=(?:rgba?|color|oklch)\()/).find(layer => layer.includes("inset")) ?? "";
        const colour = /^(rgba?\([^)]*\)|color\([^)]*\)|oklch\([^)]*\))/.exec(inset)?.[1] ?? "rgba(0, 0, 0, 0)";
        const edge = over(parse(colour), fill);
        return { ground: ground.map(Math.round), fill: fill.map(Math.round), edge: edge.map(Math.round), shadow };
      });
      const fillRatio = wcagContrast(lifted.fill, lifted.ground);
      const edgeRatio = wcagContrast(lifted.edge, lifted.ground);
      console.info(`${theme} lifted row: ground ${lifted.ground}, fill ${lifted.fill} at ${fillRatio} to 1, edge ${lifted.edge} at ${edgeRatio} to 1 (${lifted.shadow})`);
      if (theme === "light") {
        // Darker than the ground by a step, with the component tier hairline round it.
        expect(lifted.fill[0]!).toBeLessThan(lifted.ground[0]!);
        expect(fillRatio).toBeGreaterThan(1.03);
        expect(edgeRatio).toBeGreaterThanOrEqual(1.2);
      } else {
        expect(fillRatio).toBeGreaterThanOrEqual(1.1);
        expect(lifted.edge).toEqual(lifted.fill);
      }
    }
  }, 60_000);

  it("a desktop window names the computer it is on in the foot, one 36 px row under Settings in the rows' sans, in both themes", async () => {
    for (const theme of THEMES) {
      await open("sidebar-hosts", theme, "", "[data-host-foot] button");
      const foot = await page!.locator("[data-host-foot] button").evaluate(el => ({ text: el.textContent, height: el.getBoundingClientRect().height, family: getComputedStyle(el).fontFamily }));
      expect(foot.text).toBe("This Mac");
      expect(foot.height).toBe(ONE_LINE);
      expect(foot.family).not.toMatch(/mono/i);
      await shot(`sidebar-hosts-1280-${theme}`);
      await shot(`sidebar-hosts-256-${theme}`, "[data-slot=sidebar]");
    }
  }, 60_000);

  it("nothing in the sidebar wears caps or letter-spacing, and the head sits in the fixed header outside the scrolling tree", async () => {
    await open("sidebar", "dark");
    const dressed = await page!.locator("[data-sidebar-search] *, [data-sidebar-tree] *").evaluateAll(els =>
      els
        .map(el => ({ text: (el.textContent ?? "").trim().slice(0, 20), transform: getComputedStyle(el).textTransform, spacing: getComputedStyle(el).letterSpacing }))
        .filter(read => read.transform !== "none" || read.spacing !== "normal"),
    );
    expect(dressed).toEqual([]);
    expect(await page!.locator("[data-slot=sidebar-content] [data-k=project-switcher]").count()).toBe(0);
    expect(await page!.locator("[data-slot=sidebar] [data-k=project-switcher]").count()).toBe(1);
    expect(await page!.locator("[data-slot=sidebar-content] [data-sidebar-row]").count()).toBeGreaterThan(0);
  }, 30_000);

  it("each child list draws its rail per item: the height of the item on every one but the last, 18 px to the tick on the last, the tick 4 by 1 at 18 px, in both themes", async () => {
    for (const theme of THEMES) {
      await open("sidebar", theme);
      const rails = await page!.evaluate(() => {
        const items = [...document.querySelectorAll<HTMLElement>("[data-sidebar-tree] ul li")].filter(li => getComputedStyle(li.parentElement!).marginLeft === "12px");
        return {
          items: items.map(li => {
            const before = getComputedStyle(li, "::before");
            const after = getComputedStyle(li, "::after");
            return {
              id: li.querySelector<HTMLElement>("[data-sidebar-row], [data-k=no-workspaces], [data-thread-launch]")?.dataset["rowId"] ?? "leaf",
              last: li === li.parentElement!.lastElementChild,
              height: li.getBoundingClientRect().height,
              rail: parseFloat(before.height),
              railWidth: before.width,
              tick: { top: after.top, width: after.width, height: after.height },
              ink: before.backgroundColor,
            };
          }),
        };
      });
      console.info(`rails at ${theme}: ${JSON.stringify(rails)}`);
      expect(rails.items.length).toBeGreaterThan(6);
      // The rails' ink is the theme's ink at 16 percent rather than a hairline, which vanished over the light glass.
      for (const item of rails.items) {
        expect(item.railWidth, item.id).toBe("1px");
        expect(item.tick, item.id).toEqual({ top: "18px", width: "4px", height: "1px" });
        expect(item.ink, item.id).toBe(theme === "dark" ? "rgba(255, 255, 255, 0.16)" : "rgba(0, 0, 0, 0.16)");
        if (item.last) expect(item.rail, `${item.id} is last`).toBe(18);
        else expect(Math.round(item.rail), item.id).toBe(Math.round(item.height));
      }
    }
  }, 60_000);

  it("the state words read at 4.5 to 1 or better on a flat row and on the lifted row, in both themes", async () => {
    for (const theme of THEMES) {
      await open("sidebar", theme);
      const flat = await textContrast(page!, "[data-slot=sidebar] [data-thread-state]");
      expect(flat.length).toBeGreaterThan(1);
      for (const ratio of flat) expect(ratio, `a state word on a flat row reads at ${ratio} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      await open("sidebar-picked", theme, "&pick=pr_spoo", "[data-sidebar-row][data-active=true]");
      await page!.waitForTimeout(400);
      const lifted = await textContrast(page!, "[data-sidebar-row][data-active=true] [data-thread-state]");
      expect(lifted).toHaveLength(1);
      expect(lifted[0], `the lifted row's word reads at ${lifted[0]} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      await open("bring-back-paused", theme);
      await page!.keyboard.press("Escape");
      const stopped = await textContrast(page!, "[data-row-id='ws:ws_box'] [data-workspace-state]");
      expect(await page!.locator("[data-row-id='ws:ws_box'] [data-workspace-state]").textContent()).toBe("Stopped");
      expect(stopped[0], `Stopped reads at ${stopped[0]} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      console.info(`${theme}: state words on flat rows ${flat.map(r => r.toFixed(2)).join(", ")}, on the lifted row ${lifted[0]!.toFixed(2)}, Stopped ${stopped[0]!.toFixed(2)} to 1`);
    }
  }, 90_000);

  it("a project row's plus is nothing at rest and there on hover, and the row's name keeps its width between the two", async () => {
    await open("sidebar", "dark");
    const plus = page!.locator("[data-row-id='project:pr_spoo'] ~ [data-k=new-workspace]").first();
    const name = page!.locator("[data-row-id='project:pr_spoo'] [data-project-name]");
    expect(await plus.evaluate(el => getComputedStyle(el).opacity)).toBe("0");
    const before = await name.boundingBox();
    await page!.locator("[data-row-id='project:pr_spoo']").hover();
    await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-row-id='project:pr_spoo'] ~ [data-k=new-workspace]")!).opacity === "1");
    expect(await name.boundingBox()).toEqual(before);
    // The compose glyph is the one add control at rest: one plus per project row, all at nothing, and nothing else.
    const atRest = await page!.locator("[data-slot=sidebar] svg.lucide-plus").evaluateAll(els => els.map(el => getComputedStyle(el.closest("button")!).opacity));
    expect(atRest.length).toBe(3);
    expect(atRest.filter(opacity => opacity === "1")).toHaveLength(1);
  }, 30_000);

  it("the switcher's menu opens under the head at the head's width, its rows 36 px, and comes to rest with no transform, in both themes", async () => {
    for (const theme of THEMES) {
      await open("switcher-open", theme, "", "[data-project-switcher-menu]");
      // The menu slides in on the translate property and the primitive scales on transform: both at rest first.
      await page!.waitForFunction(() => {
        const style = getComputedStyle(document.querySelector("[data-slot=popover-popup]")!);
        return style.transform === "none" && style.translate === "none" && style.opacity === "1";
      });
      const read = await page!.evaluate(() => {
        const head = document.querySelector<HTMLElement>("[data-k=project-switcher]")!.getBoundingClientRect();
        const popup = document.querySelector<HTMLElement>("[data-slot=popover-popup]")!;
        const menu = popup.getBoundingClientRect();
        const style = getComputedStyle(popup);
        return {
          head: { left: head.left, right: head.right, bottom: head.bottom },
          menu: { left: menu.left, right: menu.right, top: menu.top },
          radius: style.borderTopLeftRadius,
          border: style.borderTopWidth,
          options: [...popup.querySelectorAll<HTMLElement>("[role=option], [data-k=add-project-row]")].map(el => ({ text: el.textContent, height: el.getBoundingClientRect().height })),
          field: popup.querySelector<HTMLElement>("[data-switcher-search]")!.closest("label")!.getBoundingClientRect().height,
          expanded: document.querySelector("[data-k=project-switcher]")!.getAttribute("aria-expanded"),
        };
      });
      console.info(`switcher menu at ${theme}: ${JSON.stringify(read)}`);
      expect(Math.abs(read.menu.left - read.head.left)).toBeLessThan(1);
      expect(Math.abs(read.menu.right - read.head.right)).toBeLessThan(1);
      expect(Math.round(read.menu.top - read.head.bottom)).toBe(4);
      expect(read.expanded).toBe("true");
      expect(read.border).toBe("1px");
      expect(read.options.map(option => option.text)).toEqual(["All projects", "spoo", "wsp", "landingspoo", "Add a project"]);
      for (const option of read.options) expect(option.height).toBe(ONE_LINE);
      expect(read.field).toBe(32);
      await shot(`switcher-menu-${theme}`, "[data-slot=popover-popup]");
      await shot(`switcher-open-1280-${theme}`);
    }
  }, 60_000);

  it("at 390 the sidebar is a sheet with the same rows at the same heights, in both themes", async () => {
    for (const theme of THEMES) {
      for (const [screen, extra, first] of [
        ["sidebar", "", "[data-sidebar-row]"],
        ["sidebar-picked", "&pick=pr_spoo", "[data-sidebar-row][data-active=true]"],
        ["sidebar-empty", "", "[data-k=new-project]"],
      ] as const) {
        await page!.setViewportSize({ width: 390, height: 844 });
        await page!.goto(url(screen, theme, extra));
        await page!.waitForSelector("[data-slot=sidebar-trigger]");
        // At this width the right panel of the workspace the store opens on is a sheet over the whole page; Escape
        // shuts it, and the trigger then opens the sidebar's own sheet.
        await page!.keyboard.press("Escape");
        await page!.waitForSelector("[data-slot=sheet-viewport]", { state: "detached" });
        await page!.locator("[data-slot=sidebar-trigger]").first().click();
        await page!.waitForSelector(`[data-slot=sidebar][data-mobile=true] ${first}`);
        // The sheet slides in; its rows are read once it stands still.
        await page!.waitForTimeout(400);
        const read = await rows();
        expectOneGrammar(read, `${screen} at 390 ${theme}`);
        // The sidebar is what the shot is of: the sheet on top at its centre is the sidebar's, not the right panel's.
        const onTop = await page!.evaluate(() => {
          const box = document.querySelector("[data-slot=sidebar][data-mobile=true]")!.getBoundingClientRect();
          return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("[data-slot=sidebar]") !== null;
        });
        expect(onTop, `${screen} at 390 ${theme}`).toBe(true);
        // No pointer here, so no glyph stands at rest but one: every hover glyph is at nothing except the selected
        // workspace row's chevron, whose state word yields to it; no plus is drawn but the compose glyph's square;
        // the fold rows' chevrons are their own and stay.
        const glyphsAtRest = () => page!.locator("[data-slot=sidebar][data-mobile=true] [data-sidebar=menu-action]").evaluateAll(els => els.map(el => [el.getAttribute("aria-label"), getComputedStyle(el).opacity]).filter(([, opacity]) => opacity !== "0"));
        const liftedWorkspace = () => page!.locator("[data-slot=sidebar][data-mobile=true] [data-row-id^='ws:'][data-active=true]").evaluateAll(rows => rows.map(row => [`Collapse ${row.querySelector("[data-workspace-name]")!.textContent}`, "1", getComputedStyle(row.querySelector("[data-workspace-state]")!).opacity]));
        const lifted = await liftedWorkspace();
        expect(await glyphsAtRest(), `${screen} at 390 ${theme}`).toEqual(lifted.map(([label, opacity]) => [label, opacity]));
        for (const [, , word] of lifted) expect(word).toBe("0");
        // The one plus a row may carry on its face is the empty app's New project row, which is a row and not a glyph.
        const pluses = await page!.locator("[data-slot=sidebar][data-mobile=true] svg.lucide-plus").evaluateAll(els => els.map(el => el.closest("button")!).filter(button => button.dataset["k"] !== "new-project").map(button => getComputedStyle(button).opacity));
        expect(pluses.filter(opacity => opacity !== "0")).toEqual([]);
        // A glyph that is not drawn takes no tap either: at a hidden plus's own box, 20 px wide, the tap lands on the
        // row under it, or on the head beside its chevron, and the one chevron drawn, the selected workspace row's,
        // takes its own. The glyph's box is read from its row's right edge, on the row's first line.
        const tapAt = (selector: string, fromRight: number) =>
          page!.evaluate(
            ([selector, fromRight]: readonly [string, number]) => {
              const target = document.querySelector<HTMLElement>(`[data-slot=sidebar][data-mobile=true] ${selector}`)!;
              const box = target.getBoundingClientRect();
              const hit = document.elementFromPoint(box.right - fromRight, box.top + 14);
              return { onTarget: hit?.closest("[data-sidebar-row], [data-k=project-switcher]") === target, glyph: hit?.closest("[data-sidebar=menu-action]")?.getAttribute("aria-label") ?? null };
            },
            [selector, fromRight] as const,
          );
        if (screen === "sidebar") expect(await tapAt("[data-row-id^='project:']", 18), `${screen} at 390 ${theme}, a tap at a project row's plus`).toEqual({ onTarget: true, glyph: null });
        if (screen === "sidebar-picked") expect(await tapAt("[data-k=project-switcher]", 40), `${screen} at 390 ${theme}, a tap beside the head's chevron`).toEqual({ onTarget: true, glyph: null });
        for (const [label] of lifted) expect(await tapAt("[data-row-id^='ws:'][data-active=true]", 18), `${screen} at 390 ${theme}, a tap at the selected row's chevron`).toEqual({ onTarget: false, glyph: label });
        await shot(`${screen}-390-${theme}`);
        if (screen === "sidebar") {
          // A tap on another workspace moves the one chevron with the selection.
          await page!.locator("[data-slot=sidebar][data-mobile=true] [data-row-id='ws:ws_copy']").click();
          await page!.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await page!.mouse.move(385, 840);
          await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-row-id='ws:ws_copy'][data-active=true]");
          await page!.waitForTimeout(250);
          expect(await glyphsAtRest(), `${screen} at 390 ${theme} after a tap`).toEqual([["Collapse webhook retries", "1"]]);
          await shot(`sidebar-workspace-390-${theme}`);
        }
      }
    }
  }, 150_000);
});

/** The settings screens the wireframe page holds, each with the element its shot waits on. */
const SETTINGS_SCREENS = [
  ["settings-appearance", "[data-settings-at=appearance]"],
  ["settings-light-picked", "[data-settings-at=appearance]"],
  ["settings-computers", "[data-settings-at=computers] [data-place-row=solari]"],
  ["settings-computer", "[data-settings-at='computer:p_spoo'] [data-agents-row]"],
  ["settings-computer-failed", "[data-settings-at='computer:p_lab'] [data-agents-refused]"],
  ["settings-this-mac", "[data-settings-at='computer:here'] [data-agents-row]"],
  ["settings-cloud", "[data-settings-at='computer:solari'] [data-k=image-copy]"],
  ["settings-projects", "[data-settings-at=projects] [data-project-row=pr_landing]"],
  ["settings-project", "[data-settings-at='project:pr_spoo'] [data-k=seeded]"],
  ["settings-devices", "[data-settings-at=devices] [data-device-row=d_3]"],
  ["settings-account", "[data-settings-at=account] [data-k=account-action]"],
  ["settings-keybindings", "[data-settings-at=keybindings] [data-slot=kbd]"],
  ["settings-about", "[data-settings-at=about] [data-k=app-version]"],
  ["settings-search", "[data-settings-at=search] [data-settings-row=server-icons]"],
  ["settings-over-panel", "[data-settings-at=appearance]"],
  ["settings-add-computer", "[data-k=add-computer] [data-k=road-ssh] [data-k=login]"],
  ["settings-remove-computer", "[data-k=remove-sentence]"],
] as const;
const ROW = 64;
const NARROW_ROW = 72;
const NARROW_DROPPED_ROW = 96;
const LINE = 44;
const NARROW_LINE = 56;
/** The computers whose page is photographed to its foot, in a window tall enough to hold the whole of it. */
const FOOT_SCREENS = ["settings-computer", "settings-computer-failed", "settings-this-mac"] as const;
const FOOT_SIZES = [
  { width: 1280, height: 1900 },
  { width: 390, height: 3000 },
] as const;

/** Every row, line and sidebar row of a settings screen, with its height and what it holds. */
interface SettingsRead {
  rows: { id: string; height: number; card: string; fill: string; spills: boolean; drops: boolean; chips: boolean; chipsCut: string[] }[];
  lines: { id: string; height: number; spills: boolean }[];
  sidebarRows: { id: string; height: number; active: boolean; dimmed: boolean; opacity: number }[];
  cutSegments: string[];
  /** Every word, sentence and value whose box cannot hold it: the ones a person would read cut short. */
  cutWords: string[];
  dressed: string[];
  scroll: { page: number; client: number };
  /** The opacity a held control stands at beside a live one, so a row that does nothing reads as doing nothing. */
  opacities: { held: number[]; live: number[] };
}

describe.skipIf(renderSkipped !== undefined)("the settings page laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    base = `${vite.base}/test/wireframe/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  const url = (screen: string, theme: (typeof THEMES)[number], extra = ""): string => `${base}?screen=${screen}&theme=${theme}${extra}`;
  /** Opens a screen with the computer's own scheme set to the shot's side, so the theme rule's system pick draws it. */
  const open = async (screen: string, theme: (typeof THEMES)[number], waitFor: string, size: { width: number; height: number } = { width: 1280, height: 800 }, extra = ""): Promise<void> => {
    await page!.setViewportSize(size);
    await page!.emulateMedia({ colorScheme: theme });
    await page!.goto(url(screen, theme, extra));
    await page!.waitForSelector(waitFor);
  };
  /** A shot named by its page, width and theme, the screen's own settings- prefix said once. */
  const shot = async (name: string, selector?: string): Promise<string> => {
    const path = join(SHOTS_DIR, `settings-${name.replace(/^settings-/, "")}.png`);
    if (selector === undefined) await page!.screenshot({ path });
    else await page!.locator(selector).first().screenshot({ path });
    console.info(`settings screenshot: ${path}`);
    return path;
  };

  const read = (): Promise<SettingsRead> =>
    page!.evaluate(micro => {
      const box = (el: Element) => el.getBoundingClientRect();
      const spills = (el: HTMLElement): boolean => el.scrollHeight > el.clientHeight + 1;
      const rows = [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-settings-row]")].map(el => ({
        id: el.dataset["settingsRow"] ?? "?",
        height: box(el).height,
        card: el.closest<HTMLElement>("[data-settings-card]")?.dataset["settingsCard"] ?? "?",
        fill: getComputedStyle(el).backgroundColor,
        spills: spills(el),
        // A card drops its slots below 640 px where one of its rows needs the width, and then every row of it does.
        drops: el.hasAttribute("data-settings-drops"),
        chips: el.querySelector("[data-chips]") !== null,
        // A chip cut by its own ellipsis, or standing past the row's edge.
        chipsCut: [...el.querySelectorAll<HTMLElement>("[data-chip]")]
          .filter(chip => {
            const words = chip.querySelector<HTMLElement>("span:last-child") ?? chip;
            const c = box(chip);
            const r = box(el);
            return words.scrollWidth > words.clientWidth + 1 || c.right > r.right + 0.5 || c.bottom > r.bottom + 0.5;
          })
          .map(chip => (chip.textContent ?? "").trim()),
      }));
      const lines = [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-settings-line]")].map(el => ({
        id: el.dataset["settingsLine"] ?? "?",
        height: box(el).height,
        spills: spills(el),
      }));
      // A word cut is one whose own box cannot hold it: sideways where it stands on one line, or below the last
      // line it is allowed where it wraps.
      const cutWords = [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-settings-word], [data-settings-page] [data-settings-description], [data-settings-page] [data-settings-label]")]
        .filter(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
        .map(el => `${(el.textContent ?? "").trim()} [${el.scrollWidth}/${el.clientWidth} ${el.scrollHeight}/${el.clientHeight}]`);
      const opacity = (selector: string): number[] => [...document.querySelectorAll<HTMLElement>(selector)].map(el => Number(getComputedStyle(el).opacity));
      const sidebarRows = [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-sidebar-row]")].map(el => ({
        id: el.dataset["rowId"] ?? "?",
        height: box(el).height,
        active: el.dataset["active"] === "true",
        dimmed: el.hasAttribute("data-dimmed"),
        opacity: Number(getComputedStyle(el).opacity),
      }));
      const cutSegments = [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-slot=segmented-control] [role=radio]")].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent ?? "");
      // Caps and tracked-out words outside the one small label, which wears MICRO_LABEL itself or sits inside it; the
      // page title's tight tracking draws it closer, which is no dress, and a picture's masked code is not words.
      const eyebrow = (el: Element): boolean => {
        for (let n: Element | null = el; n !== null; n = n.parentElement) if (micro.every(c => n!.classList.contains(c))) return true;
        return false;
      };
      const dressed = [...document.querySelectorAll<HTMLElement>("[data-settings-page] *, [data-slot=sidebar] *")]
        .filter(el => {
          const s = getComputedStyle(el);
          return /\p{L}/u.test(el.textContent ?? "") && (s.textTransform !== "none" || parseFloat(s.letterSpacing) > 0) && !eyebrow(el);
        })
        .map(el => (el.textContent ?? "").trim().slice(0, 20));
      const pageEl = document.querySelector<HTMLElement>("[data-settings-page]")!;
      const viewport = pageEl.closest<HTMLElement>("[data-slot=scroll-area-viewport]")!;
      return {
        rows,
        lines,
        sidebarRows,
        cutSegments,
        cutWords,
        dressed,
        scroll: { page: Math.max(pageEl.scrollWidth, viewport.scrollWidth), client: viewport.clientWidth },
        opacities: { held: opacity("[data-settings-page] [data-slot=button][data-held]"), live: opacity("[data-settings-page] [data-slot=button]:not([data-held]):not(:disabled)") },
      };
    }, MICRO_LABEL.split(" "));

  const expectGrammar = (got: SettingsRead, where: string, narrow: boolean): void => {
    // One height per kind at each width: a row is 64, 72 below 640 px, or 96 there where its slot has moved under a
    // description holding two lines; a line is 44, or 56 there where its value stands under its label. A row
    // carrying chips grows until no chip is cut, so it is held to that rather than to a height.
    for (const row of got.rows) {
      expect(row.fill, `${row.id} at ${where} carries no fill of its own`).toBe("rgba(0, 0, 0, 0)");
      if (row.chips) expect(row.chipsCut, `chips cut in ${row.id} at ${where}`).toEqual([]);
      else expect(row.height, `a row of ${row.card} at ${where}`).toBe(narrow ? (row.drops ? NARROW_DROPPED_ROW : NARROW_ROW) : ROW);
      expect(row.spills, `${row.id} at ${where} holds what it says`).toBe(false);
    }
    for (const line of got.lines) {
      expect(line.height, `${line.id} at ${where}`).toBe(narrow ? NARROW_LINE : LINE);
      expect(line.spills, `${line.id} at ${where} holds what it says`).toBe(false);
    }
    for (const row of got.sidebarRows) expect(row.height, `${row.id} at ${where}`).toBe(ONE_LINE);
    expect(got.cutSegments, `segments cut at ${where}`).toEqual([]);
    expect(got.dressed, `caps or tracking at ${where}`).toEqual([]);
    expect(got.scroll.page, `sideways scroll at ${where}`).toBeLessThanOrEqual(got.scroll.client);
    // A control nobody can press stands further down the opacity ramp than every live one beside it.
    for (const held of got.opacities.held) for (const live of got.opacities.live) expect(held, `a held control at ${where} against a live one`).toBeLessThan(live);
    // A row with no match for the typed text stands back by opacity, which reads the same way on both sides; an
    // ink swap read brighter than the rest ink on dark and did nothing on light.
    for (const row of got.sidebarRows) expect(row.opacity, `${row.id} at ${where}`).toBe(row.dimmed ? 0.5 : 1);
  };

  it("every row is 64 px and every line 44, a row of chips whole whatever its height, the sidebar rows 36 with exactly one lifted, no caps but the small mono labels, no fill on a row, no cut segment and no sideways scroll, on every screen in both themes at 1280, photographed", async () => {
    for (const theme of THEMES) {
      for (const [screen, waitFor] of SETTINGS_SCREENS) {
        await open(screen, theme, waitFor);
        const got = await read();
        // At this width a description is cut with the whole on its hover, which is the grammar; the log names the
        // ones that are, so a judge reading the shots and a reader of the report see the same list.
        console.info(`${screen} ${theme}: rows ${JSON.stringify(got.rows.map(r => [r.id, r.height]))}, lines ${JSON.stringify(got.lines.map(l => [l.id, l.height]))}, cut ${JSON.stringify(got.cutWords)}`);
        expectGrammar(got, `${screen} ${theme} 1280`, false);
        // While the results stand in the centre no row is the page, so the search screen lifts none.
        expect(got.sidebarRows.filter(row => row.active).length, `lifted rows on ${screen} ${theme}`).toBe(screen === "settings-search" ? 0 : 1);
        // The muted words read at AA on both sides: descriptions, state words and the sub-heads.
        const ratios = await textContrast(page!, "[data-settings-page] [data-settings-description], [data-settings-page] [data-settings-word], [data-settings-page] [data-settings-head], [data-settings-page] [data-settings-mark]");
        for (const ratio of ratios) expect(ratio, `muted text on ${screen} ${theme} reads at ${ratio}`).toBeGreaterThanOrEqual(4.5);
        await shot(`${screen}-1280-${theme}`);
      }
    }
  }, 300_000);

  it("at 390 a card holding a value stands its rows at 96 with the slot under a two-line description and every other card at 72, a row of chips grows until no chip is cut, every line at 56 with its right side under its label, nothing cut, and the settings sidebar is the sheet with the groups", async () => {
    for (const theme of THEMES) {
      for (const [screen, waitFor] of SETTINGS_SCREENS) {
        if (screen === "settings-search") continue;
        await open(screen, theme, waitFor, { width: 390, height: 844 });
        const got = await read();
        expectGrammar(got, `${screen} ${theme} 390`, true);
        // Nothing a person reads is cut at a width with no hover to read the whole on.
        expect(got.cutWords, `words cut at ${screen} ${theme} 390`).toEqual([]);
        await shot(`${screen}-390-${theme}`);
      }
      // The sheet: the groups at 36 px, one lifted; then the field's results in the sheet, a tap landing on the row.
      await open("settings-appearance", theme, "[data-settings-at=appearance]", { width: 390, height: 844 });
      await page!.locator("[data-slot=sidebar-trigger]").first().click();
      await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-settings-groups]");
      await page!.waitForTimeout(400);
      const sheet = await read();
      for (const row of sheet.sidebarRows) expect(row.height).toBe(ONE_LINE);
      expect(sheet.sidebarRows.filter(row => row.active).map(row => row.id)).toEqual(["group:appearance"]);
      await shot(`settings-appearance-390-sheet-${theme}`);
      await page!.locator("[data-slot=sidebar][data-mobile=true] [data-k=settings-search] input, [data-slot=sidebar][data-mobile=true] input[data-k=settings-search]").first().fill("icons");
      await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-row-id='result:privacy:server-icons']");
      // The centre keeps its page while the results stand in the sheet.
      expect(await page!.locator("[data-settings-page]").getAttribute("data-settings-at")).toBe("appearance");
      await shot(`settings-search-390-sheet-${theme}`);
      await page!.locator("[data-slot=sidebar][data-mobile=true] [data-row-id='result:privacy:server-icons']").click();
      await page!.waitForSelector("[data-slot=sidebar][data-mobile=true]", { state: "detached" });
      expect(await page!.locator("[data-settings-page]").getAttribute("data-settings-at")).toBe("privacy");
    }
  }, 300_000);

  it("About while behind in the app on its own host: Get, Downloading held, then Quit and open, nothing cut, photographed", async () => {
    for (const theme of THEMES) {
      await open("settings-about-behind", theme, "[data-settings-at=about] [data-k=latest-version]");
      const get = page!.locator("[data-k=get-release]");
      await page!.waitForFunction(() => document.querySelector<HTMLElement>("[data-k=get-release]")?.title !== "");
      expect(await get.textContent()).toBe("Get 0.3.0");
      expect((await read()).cutWords, `words cut at settings-about-behind ${theme}`).toEqual([]);
      await shot(`settings-about-behind-1280-${theme}`);
      await get.click();
      await page!.waitForSelector("[data-k=get-release]:disabled");
      expect(await get.textContent()).toBe("Downloading");
      expect((await read()).cutWords, `words cut at settings-about-downloading ${theme}`).toEqual([]);
      await shot(`settings-about-downloading-1280-${theme}`);
      await page!.evaluate(() => (window as unknown as { finishBundle: () => void }).finishBundle());
      await page!.waitForSelector("[data-k=get-release]:not(:disabled)");
      expect(await get.textContent()).toBe("Quit and open");
      expect((await read()).cutWords, `words cut at settings-about-kept ${theme}`).toEqual([]);
      await shot(`settings-about-kept-1280-${theme}`);
    }
  }, 120_000);

  it("About with newer files under the running host: Restart host in Get's place, nothing cut, photographed", async () => {
    for (const theme of THEMES) {
      await open("settings-about-restart", theme, "[data-settings-at=about] [data-k=restart-host]");
      expect(await page!.locator("[data-settings-card=about] button").allTextContents()).toEqual(["Restart host", "Releases"]);
      expect((await read()).cutWords, `words cut at settings-about-restart ${theme}`).toEqual([]);
      await shot(`settings-about-restart-1280-${theme}`);
    }
  }, 120_000);

  it("photographs a computer's page to its foot at both widths, so its skills, its workspaces and its two acts are read", async () => {
    for (const theme of THEMES) {
      for (const screen of FOOT_SCREENS) {
        const waitFor = SETTINGS_SCREENS.find(([name]) => name === screen)![1];
        for (const size of FOOT_SIZES) {
          await open(screen, theme, waitFor, size);
          // The whole page is in the window, so the shot ends where the page does rather than where the fold is.
          const over = await page!.evaluate(() => {
            const el = document.querySelector<HTMLElement>("[data-settings-page]")!;
            const viewport = el.closest<HTMLElement>("[data-slot=scroll-area-viewport]")!;
            return el.scrollHeight - viewport.clientHeight;
          });
          expect(over, `${screen} at ${size.width} by ${size.height} stands whole in the window`).toBeLessThanOrEqual(0);
          await shot(`${screen}-foot-${size.width}-${theme}`);
        }
      }
    }
  }, 180_000);

  it("holds the room for the sub-rows whichever group is open, so picking Computers moves no group under it", async () => {
    const tops = (): Promise<Record<string, number>> =>
      page!.evaluate(() =>
        Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-sidebar-row]")].map(el => [el.dataset["rowId"] ?? "?", Math.round(el.getBoundingClientRect().top)])),
      );
    await open("settings-appearance", "dark", "[data-settings-at=appearance]");
    const before = await tops();
    expect(Object.keys(before)).toContain("computer:p_spoo");
    await page!.locator("[data-k=settings-computers]").click();
    await page!.waitForSelector("[data-settings-at=computers]");
    const after = await tops();
    for (const [id, top] of Object.entries(before)) expect(after[id], `${id} stayed where it was`).toBe(top);
  }, 60_000);

  it("the Light theme picked on the dark side draws the page light, and Restore defaults stands only off the defaults and puts the page back", async () => {
    await open("settings-light-picked", "dark", "[data-settings-at=appearance]");
    await page!.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    // The grid under the side segments holds the light side's pictures, with the light pick checked.
    expect(await page!.locator("[data-k=theme-picker] [data-theme-option][aria-checked=true]").getAttribute("data-theme-option")).toBe(DEFAULT_PREFERENCES.lightTheme);
    expect(await page!.locator("[data-k=restore-defaults]").count()).toBe(1);
    await shot("light-picked-1280-dark");
    await page!.locator("[data-k=restore-defaults]").click();
    await page!.waitForFunction(() => document.documentElement.classList.contains("dark"));
    expect(await page!.locator("[data-k=restore-defaults]").count()).toBe(0);
    await open("settings-appearance", "dark", "[data-settings-at=appearance]");
    expect(await page!.locator("[data-k=restore-defaults]").count()).toBe(0);
  }, 60_000);

  it("Settings takes the whole region right of the sidebar and the panel comes back on the chord, in both windows", async () => {
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1024, height: 700 },
    ]) {
      await open("settings-over-panel", "dark", "[data-settings-at=appearance]", size);
      expect(await page!.locator("[data-preview-panel-mode]").count()).toBe(0);
      expect(await page!.locator("[data-right-panel-tabbar]").count()).toBe(0);
      expect(await page!.locator("[data-panel-layout-controls]").count()).toBe(0);
      const region = await page!.evaluate(() => {
        const centre = document.querySelector("[data-shell-center]")!.getBoundingClientRect();
        const sidebar = document.querySelector("[data-slot=sidebar-inner]")!.getBoundingClientRect();
        return { gap: Math.round(centre.x - sidebar.right), right: Math.round(centre.right), width: Math.round(centre.width), sidebar: Math.round(sidebar.width) };
      });
      expect(region.gap).toBeLessThanOrEqual(1);
      expect(region.right).toBe(size.width);
      console.info(`settings region at ${size.width}: sidebar ${region.sidebar}, region ${region.width}`);
      // The chord the app reads is the one the browser's own platform gives it, so the press has to follow the
      // platform too: pinned to the Mac's key, this case waited 30 s for a panel no Ctrl had asked for.
      await page!.keyboard.press("ControlOrMeta+Comma");
      await page!.waitForSelector("[data-right-panel-tabbar]");
      expect(await page!.locator("[data-settings-groups]").count()).toBe(0);
    }
  }, 60_000);

  it("at 390 the sheet opened on the workspace body stays open with the settings body when Settings opens from its foot row", async () => {
    await page!.setViewportSize({ width: 390, height: 844 });
    await page!.emulateMedia({ colorScheme: "dark" });
    await page!.goto(url("sidebar", "dark"));
    await page!.waitForSelector("[data-slot=sidebar-trigger]");
    await page!.keyboard.press("Escape");
    await page!.waitForSelector("[data-slot=sheet-viewport]", { state: "detached" });
    await page!.locator("[data-slot=sidebar-trigger]").first().click();
    await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-k=settings-row]");
    await page!.locator("[data-slot=sidebar][data-mobile=true] [data-k=settings-row]").click();
    await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-settings-groups]");
    expect(await page!.locator("[data-slot=sidebar][data-mobile=true] [data-sidebar-tree]").count()).toBe(0);
    await shot("from-foot-390-dark");
  }, 60_000);

  it("Add a computer stands inline on Computers: three road pictures of one size on one row that stack on a phone, and the ssh road open under them with its fields at one height and every step listed", async () => {
    const READY = "[data-k=add-computer] [data-k=road-ssh] [data-k=login]";
    const layout = () =>
      page!.evaluate(() => {
        const box = (el: Element) => {
          const b = el.getBoundingClientRect();
          return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) };
        };
        const pictures = [...document.querySelectorAll("[data-k=add-roads] [data-add-road] > span:first-child")].map(box);
        const fields = [...document.querySelectorAll("[data-k=road-ssh] input")].map(box);
        return { pictures, fields, roads: box(document.querySelector("[data-k=add-roads]")!), panel: box(document.querySelector("[data-k=road-ssh]")!), steps: document.querySelectorAll("[data-k=road-ssh] [data-k=plan] li").length };
      });
    for (const theme of THEMES) {
      await open("settings-add-computer", theme, READY);
      const wide = await layout();
      console.info(`add a computer at 1280 ${theme}: ${JSON.stringify(wide)}`);
      expect(wide.pictures).toHaveLength(3);
      expect(new Set(wide.pictures.map(p => p.y)).size).toBe(1);
      expect(new Set(wide.pictures.map(p => `${p.w}x${p.h}`)).size).toBe(1);
      expect(wide.panel.y).toBeGreaterThanOrEqual(wide.roads.bottom);
      expect(wide.fields).toHaveLength(3);
      expect(new Set(wide.fields.map(f => f.h)).size).toBe(1);
      expect(new Set(wide.fields.map(f => f.y)).size).toBe(1);
      expect(wide.steps).toBe(PlaceAddStep.options.length);
      await shot(`add-computer-1280-${theme}`, "[data-k=add-computer]");
    }
    await open("settings-add-computer", "dark", READY, { width: 390, height: 844 });
    const phone = await layout();
    console.info(`add a computer at 390: ${JSON.stringify(phone)}`);
    expect(new Set(phone.pictures.map(p => p.x)).size).toBe(1);
    expect(phone.pictures[1]!.y).toBeGreaterThan(phone.pictures[0]!.y);
    expect(new Set(phone.fields.map(f => f.x)).size).toBe(1);
    await shot("add-computer-390-dark", "[data-k=add-computer]");
  }, 90_000);

  it("Computers draws each refusal where its control is, in the host's two halves: the add this window watched fail under its fields, the places read above Add a computer, the ssh config where its hosts would be", async () => {
    const slotRead = (k: string) =>
      page!.evaluate(key => {
        const slot = document.querySelector<HTMLElement>(`[data-k=${key}]`)!;
        const panel = document.querySelector<HTMLElement>("[data-settings-page]")!.getBoundingClientRect();
        const b = slot.getBoundingClientRect();
        return { text: slot.textContent, fix: slot.querySelector("span.text-foreground")?.textContent?.trim() ?? null, inside: b.left >= panel.left && b.right <= panel.right + 0.5, h: Math.round(b.height) };
      }, k);
    for (const theme of THEMES) {
      await open("settings-add-computer-failed", theme, "[data-k=ssh-refusal]");
      const add = await slotRead("ssh-refusal");
      console.info(`add refused ${theme}: ${JSON.stringify(add)}`);
      expect(add.text).toBe("spoo has no curl or wget on its PATH. Install one of them there, then add again.");
      expect(add.fix).toBe("Install one of them there, then add again.");
      expect(add.inside).toBe(true);
      expect(add.h).toBeGreaterThanOrEqual(36);
      expect(await page!.locator("[data-k=road-ssh] [data-k=plan] li[data-state=failed]").count()).toBe(1);
      expect(await page!.locator("[data-k=road-ssh] [data-k=login]").inputValue()).toBe("spoo");
      await page!.waitForTimeout(400);
      await shot(`add-computer-refused-${theme}`, "[data-k=add-computer]");

      await open("settings-computers-refused", theme, "[data-k=ssh-hosts-refused]");
      const places = await slotRead("places-refused");
      const hosts = await slotRead("ssh-hosts-refused");
      console.info(`computers refused ${theme}: ${JSON.stringify({ places, hosts })}`);
      expect(places.fix).toBe("Fix or move ~/.wsp/state.json, then start wsp again.");
      expect(places.inside).toBe(true);
      expect(hosts.text).toBe("Hosts from your ssh config not read: ~/.ssh/config: permission denied");
      expect(hosts.inside).toBe(true);
      // The page that draws the refusal is on screen, so no notice says it again.
      expect(await page!.locator("[data-notice]").count()).toBe(0);
      // The road opens with a 200 ms rise; the shots wait it out.
      await page!.waitForTimeout(400);
      await shot(`computers-refused-${theme}`);
      await shot(`computers-refused-add-${theme}`, "[data-k=add-computer]");
    }
  }, 90_000);
});
