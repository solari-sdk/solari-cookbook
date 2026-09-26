// SPDX-License-Identifier: AGPL-3.0-only
// The export dialog in a real Chromium, both themes: one container whose
// sections are told apart by a hairline and a small label alone, no section
// with a fill or a border colour of its own, no step ledger, every agent and
// summary row one height, the ticks on the neutral ramp, the one slot above
// the footer empty at rest, reading the step at AA mid-download and the landed
// line at done, the refusal for an existing destination the one loud line and
// the only thing that changes colour, never cut even when the destination is
// one unbroken 120-character path, and nothing moving from rest through the
// download to done. Photographed at open, mid-download, at the refusal, at a
// long refusal, after it landed, with no threads, and at a phone's width.
// Runs only when asked for (WSP_RENDER=1) and skips without Playwright's
// Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`export layout render test skipped: ${renderSkipped}`);

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SOURCE = "/Users/me/code/spoo";
const LANDED = "spoo is at /Users/me/code/spoo on this Mac.";
const REFUSED = "/Users/me/code/spoo already exists on this computer with 1204 files; export with replace to overwrite it";
const LONG = "/Users/me/code/clients/northwind-traders/platform/services/billing-reconciliation/workers/nightly-settlements-batch/spoo";
const DOWNLOADING = "Downloading the folder, 31 MB";
const NOT_LANDED = "when it lands";
/** Two lines of the status line's text, its floor; a third line grows it past this. */
const ROW = 28;
const SECTIONS = ["[data-k=source]", "[data-k=dest]", "[data-k=agents]", "[data-k=summary]"] as const;

describe.skipIf(renderSkipped !== undefined)("the export dialog laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/export/index.html");
    base = `${vite.base}/test/export/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  const boxes = async (selector: string): Promise<Box[]> => {
    const all = await page!.locator(selector).all();
    const out: Box[] = [];
    for (const l of all) {
      const b = await l.boundingBox();
      if (!b) throw new Error(`${selector} has no box`);
      out.push(b);
    }
    return out;
  };
  const box = async (selector: string): Promise<Box> => (await boxes(selector))[0]!;
  /** The row a fact's value sits in: its value fills in place, so the row is what must hold still. */
  const rowOf = (selector: string): Promise<Box> => page!.locator(selector).first().evaluate(el => { const r = el.parentElement!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const heights = (b: Box[]): number[] => b.map(x => Math.round(x.height));
  const style = (selector: string, prop: string): Promise<string[]> => page!.locator(selector).evaluateAll((els, p) => els.map(el => getComputedStyle(el).getPropertyValue(p)), prop);
  const textColor = (selector: string): Promise<string> => page!.locator(selector).first().evaluate(el => getComputedStyle(el).color);
  const contrast = (selector: string): Promise<number[]> => textContrast(page!, selector);
  const whole = (selector: string): Promise<boolean[]> => page!.locator(selector).evaluateAll(els => els.map(el => el.scrollWidth <= el.clientWidth));
  /** The element's text fits its box in both directions: nothing cut by an ellipsis, no line pushed past its height. */
  const uncut = (selector: string): Promise<boolean> => page!.locator(selector).first().evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight);
  const open = async (query: string, dest = SOURCE): Promise<void> => {
    await page!.goto(`${base}?${query}`);
    await page!.waitForFunction(path => document.querySelector("[data-k=dest] [data-k=path]")?.textContent === path, dest);
  };
  /** Where everything that must hold still sits: the container, every section, an agent row, both summary rows, the slot and the action key. */
  const frame = async (): Promise<Record<string, Box>> => ({
    dialog: await box("[role=dialog]"),
    source: await box("[data-k=source]"),
    dest: await box("[data-k=dest]"),
    agents: await box("[data-k=agents]"),
    agentRow: await box("[data-k=agents] li"),
    summary: await box("[data-k=summary]"),
    filesRow: await rowOf("[data-k=files]"),
    cachesRow: await rowOf("[data-k=caches]"),
    progress: await box("[data-k=progress]"),
    button: await box("[data-slot=dialog-footer] button:last-child"),
  });
  /** The frame with the action key's width left out: its words change with the phase, its row does not. */
  const still = (f: Record<string, Box>, button: Box): Record<string, Box> => ({ ...f, button: { ...f["button"]!, x: button.x, width: button.width } });

  it.each(["dark", "light"] as const)("in the %s theme one container of quiet sections, rows of one height, neutral ticks, an empty slot, and nothing moves through the export", async theme => {
    await open(`theme=${theme}`);
    const dialog = page!.locator("[role=dialog]");

    const agentRows = await boxes("[data-k=agents] li");
    expect(agentRows).toHaveLength(3);
    expect(new Set(heights(agentRows)).size).toBe(1);
    const summary = await boxes("[data-k=files], [data-k=caches]");
    expect(summary).toHaveLength(2);
    expect(new Set(heights(summary)).size).toBe(1);
    expect(new Set(heights(await boxes("[data-k=source] label, [data-k=dest] p, [data-k=agents] p, [data-k=summary] p"))).size).toBe(1);
    expect(await page!.locator("[data-step]").count()).toBe(0);

    // One container: every section is dressed alike, a hairline above and no fill or border colour of its own.
    for (const prop of ["background-color", "border-top-color", "border-left-width", "border-radius"]) {
      const values = await Promise.all(SECTIONS.map(s => style(s, prop)));
      expect(new Set(values.flat()).size, prop).toBe(1);
    }
    expect((await style("[data-k=agents]", "background-color"))[0]).toBe("rgba(0, 0, 0, 0)");
    expect((await style("[data-k=source]", "border-top-width"))[0]).toBe("0px");
    expect((await style("[data-k=dest]", "border-top-width"))[0]).toBe("1px");

    // The ticks fill from the neutral ramp: a checked one is the text colour, not the accent the Export key carries.
    const foreground = (await style("[data-k=agents] li > span", "color"))[0];
    const fills = await style("[role=checkbox][data-checked] [data-slot=checkbox-indicator]", "background-color");
    expect(fills).toHaveLength(3);
    expect(new Set(fills)).toEqual(new Set([foreground]));
    const exportFill = (await style("[data-slot=dialog-footer] button:last-child", "background-color"))[0];
    expect(exportFill).not.toBe(foreground);
    expect((await style("[data-slot=dialog-footer] button:first-child", "background-color"))[0]).not.toBe(exportFill);

    expect(await page!.locator("[data-k=agents] [role=checkbox]").evaluateAll(els => els.map(el => el.getAttribute("aria-checked")))).toEqual(["true", "true", "true"]);
    expect(await page!.locator("[data-k=files]").textContent()).toBe(NOT_LANDED);
    expect(await page!.locator("[data-k=caches]").textContent()).toBe(NOT_LANDED);
    expect((await style("[data-k=files]", "color"))[0]).toBe((await style("[data-k=agents] > p", "color"))[0]);
    expect(Math.round(summary[1]!.y - summary[0]!.y)).toBe(ROW);
    expect(await page!.locator("[data-k=progress-line]").textContent()).toBe("");
    expect(await page!.locator("[role=progressbar]").count()).toBe(0);

    await dialog.screenshot({ path: join(SHOTS, `export-open-${theme}.png`) });
    const before = await frame();
    expect(Math.round(before["progress"]!.height)).toBeGreaterThanOrEqual(ROW);
    const quiet = await textColor("[role=status]");

    await page!.locator("button:has-text('Export')").click();
    await page!.waitForFunction(line => document.querySelector("[data-k=progress-line]")?.textContent === line && document.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow") === "50", DOWNLOADING);
    expect(await page!.locator("[role=progressbar]").getAttribute("aria-label")).toBe(DOWNLOADING);
    const during = await frame();
    expect(during).toEqual(before);
    const words = await contrast("[data-k=progress-line]");
    console.info(`${theme}: the progress line reads at ${words.join(", ")} to 1`);
    for (const ratio of words) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await dialog.screenshot({ path: join(SHOTS, `export-during-${theme}.png`) });

    await page!.waitForFunction(line => document.querySelector("[role=status]")?.textContent === line, LANDED);
    expect(await uncut("[role=status]")).toBe(true);
    expect(await page!.locator("[data-k=progress-line]").textContent()).not.toContain("Done");
    expect(await page!.locator("[role=progressbar]").getAttribute("aria-valuenow")).toBe("100");
    expect(await page!.locator("[role=progressbar]").getAttribute("aria-label")).toBe(LANDED);
    const after = await frame();
    expect(after).toEqual(still(before, after["button"]!));
    expect(await textColor("[role=status]")).toBe(quiet);
    expect(await page!.locator("[data-k=outcome]").allTextContents()).toEqual(["moved", "transcripts landed, not yet listed, 1 rollout skipped", "nothing to bring"]);
    expect(await whole("[data-k=outcome]")).toEqual([true, true, true]);
    expect(await page!.locator("[data-k=files]").textContent()).toBe("1202 files 38 MB");
    expect(await page!.locator("[data-k=caches]").textContent()).toBe("4 folders");
    await dialog.screenshot({ path: join(SHOTS, `export-done-${theme}.png`) });
    expect(existsSync(join(SHOTS, `export-done-${theme}.png`))).toBe(true);

    expect(await page!.locator("[data-k=cache-list]").count()).toBe(0);
    await page!.locator("[data-k=caches] button").click();
    await page!.waitForSelector("[data-k=cache-list]");
    expect(await page!.locator("[data-k=cache-list]").textContent()).toBe("node_modules, dist, .venv, coverage");
    expect(await uncut("[data-k=cache-list]")).toBe(true);
  }, 60_000);

  it.each(["dark", "light"] as const)("in the %s theme an existing destination is the one loud line, reads at AA with no bar, and Replace and export lands without moving anything", async theme => {
    await open(`theme=${theme}&exists=1`);
    const dialog = page!.locator("[role=dialog]");
    const before = await frame();
    const quiet = await textColor("[role=status]");
    const hairlines = await Promise.all(SECTIONS.map(s => style(s, "border-top-color")));

    await page!.locator("button:has-text('Export')").click();
    await page!.waitForFunction(line => document.querySelector("[role=status]")?.textContent === line, REFUSED);
    const refused = await frame();
    expect(refused).toEqual(still(before, refused["button"]!));
    expect(await textColor("[role=status]")).not.toBe(quiet);
    expect(await page!.locator("[role=progressbar]").count()).toBe(0);
    expect(await Promise.all(SECTIONS.map(s => style(s, "border-top-color")))).toEqual(hairlines);
    const loud = await contrast("[role=status]");
    console.info(`${theme}: the refusal reads at ${loud.join(", ")} to 1`);
    for (const ratio of loud) expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(await page!.locator("button:has-text('Replace and export')").count()).toBe(1);
    expect(await uncut("[role=status]")).toBe(true);
    await dialog.screenshot({ path: join(SHOTS, `export-refused-${theme}.png`) });

    await page!.locator("button:has-text('Replace and export')").click();
    await page!.waitForFunction(line => document.querySelector("[role=status]")?.textContent === line, LANDED);
    const after = await frame();
    expect(after).toEqual(still(before, after["button"]!));
    expect(await textColor("[role=status]")).toBe(quiet);
    expect(await uncut("[role=status]")).toBe(true);
  }, 40_000);

  it.each(["dark", "light"] as const)("in the %s theme a tab browses the destination instead of picking it, in one quiet list on the consent rows' height", async theme => {
    await page!.goto(`${base}?theme=${theme}&tab=1`);
    // The browser opens where the last import here was read from, which nothing in this file wrote; cleared so the
    // case starts from a first visit whatever ran before it.
    await page!.evaluate(() => window.localStorage.clear());
    await page!.reload();
    await page!.waitForFunction(() => document.querySelectorAll("[data-k=browse-folder]").length === 8);
    const rows = await boxes("[data-k=browse-folder]");
    expect(new Set(heights(rows)).size).toBe(1);
    // The rows stand on the height the consent rows the sections hold already stand on.
    expect(heights(rows)[0]).toBe(heights(await boxes("[data-k=agents] li"))[0]);
    // Nothing loud: inside the section that holds it the list carries no fill, border or corner of its own.
    for (const prop of ["background-color", "border-top-width", "border-left-width", "border-radius"]) {
      expect((await style("[data-k=browse]", prop))[0], prop).toBe(prop === "background-color" ? "rgba(0, 0, 0, 0)" : "0px");
    }
    expect(await page!.locator("button:has-text('Choose folder')").count()).toBe(0);

    await page!.locator("[data-folder='/Users/me/code']").click();
    await page!.waitForFunction(() => document.querySelector("[data-k=browse-state]")?.textContent === "4 folders in /Users/me/code, 2 hidden.");
    await page!.locator("button:has-text('Use this folder')").click();
    await page!.waitForFunction(() => (document.querySelector("#export-dest") as HTMLInputElement | null)?.value === "/Users/me/code/spoo");
    const quiet = await contrast("[data-k=browse-state]");
    console.info(`${theme}: the browser's state words read at ${quiet.join(", ")} to 1`);
    for (const ratio of quiet) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `export-browse-${theme}.png`) });
  }, 40_000);

  it.each(["dark", "light"] as const)("in the %s theme a refusal that begins with a 120-character path wraps whole, and so does the landed line under it", async theme => {
    await open(`theme=${theme}&exists=1&long=1`, LONG);
    const dialog = page!.locator("[role=dialog]");
    const before = await frame();
    expect(Math.round((await box("[role=status]")).height)).toBe(ROW);

    await page!.locator("button:has-text('Export')").click();
    await page!.waitForFunction(path => document.querySelector("[role=status]")?.textContent?.startsWith(path), LONG);
    expect(await uncut("[role=status]")).toBe(true);
    const refused = await frame();
    expect(refused["progress"]!.height).toBeGreaterThan(before["progress"]!.height);
    expect(refused["agentRow"]!.height).toBe(before["agentRow"]!.height);
    expect(refused["summary"]!.height).toBe(before["summary"]!.height);
    await dialog.screenshot({ path: join(SHOTS, `export-refused-long-${theme}.png`) });

    await page!.locator("button:has-text('Replace and export')").click();
    await page!.waitForFunction(path => document.querySelector("[role=status]")?.textContent === `spoo is at ${path} on this Mac.`, LONG);
    expect(await uncut("[role=status]")).toBe(true);
    expect(await whole("[data-k=outcome]")).toEqual([true, true, true]);
  }, 40_000);

  it.each(["dark", "light"] as const)("at a phone's width in the %s theme the dialog fits, the rows keep one height and every outcome is whole or rides its title once it landed", async theme => {
    await page!.setViewportSize({ width: 390, height: 844 });
    try {
      await open(`theme=${theme}`);
      const dialog = await box("[role=dialog]");
      expect(dialog.width).toBeLessThanOrEqual(390);
      expect(new Set(heights(await boxes("[data-k=agents] li"))).size).toBe(1);
      await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `export-open-390-${theme}.png`) });
      await page!.locator("button:has-text('Export')").click();
      await page!.waitForFunction(line => document.querySelector("[role=status]")?.textContent === line, LANDED);
      expect(new Set(heights(await boxes("[data-k=agents] li"))).size).toBe(1);
      // An outcome the row cannot hold at this width is cut with an ellipsis and rides its title whole.
      expect(await page!.locator("[data-k=outcome]").evaluateAll(els => els.map(el => el.scrollWidth <= el.clientWidth || el.getAttribute("title") === el.textContent))).toEqual([true, true, true]);
      console.info(`${theme}: outcomes whole at 390 px: ${(await whole("[data-k=outcome]")).join(", ")}`);
      expect(await uncut("[role=status]")).toBe(true);
      await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `export-done-390-${theme}.png`) });
    } finally {
      await page!.setViewportSize({ width: 1200, height: 900 });
    }
  }, 40_000);

  it.each(["dark", "light"] as const)("in the %s theme with no threads the sessions section is one muted line and the slot sits right under the summary", async theme => {
    await open(`theme=${theme}&threads=0`);
    expect(await page!.locator("[data-k=agents] li").count()).toBe(0);
    expect(await page!.locator("[data-k=agents] p").last().textContent()).toBe("No threads here. Every agent's sessions for the folder come home with it.");
    const caches = await box("[data-k=caches]");
    const progress = await box("[data-k=progress]");
    expect(progress.y - (caches.y + caches.height)).toBeLessThan(40);
    const ratios = await textContrast(page!, "[role=dialog] .text-muted-foreground");
    console.info(`${theme}: the empty dialog's muted lines read at ${ratios.map(r => r.toFixed(2)).join(", ")} to 1`);
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `export-plain-${theme}.png`) });
  }, 30_000);
});
