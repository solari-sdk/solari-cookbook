// SPDX-License-Identifier: AGPL-3.0-only
// The composer's slash menu and its one-line slot in a real Chromium, both
// themes, on a thread whose init announced the CLI's own screens beside the
// commands that run: the menu lists the ones that run and none of the screens,
// and Enter on a typed screen command starts nothing, the draft stays, and the
// slot holds one muted mono sentence naming wsp's own control for it. Both
// states are photographed. Runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { screenCommandLine } from "@wsp/protocol";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(tmpdir(), "wsp-render");

/** What the fixture's init announced and what its catalog calls a screen; the two lists it draws from live in test/shell/main.tsx. */
const RUNS = ["compact", "context", "cost", "init", "review", "unslop"];
const SCREENS = ["login", "logout", "model", "permissions", "config", "help"];
const LOGIN_LINE = screenCommandLine({ name: "login", control: "sign-in" }, { label: "Claude Code" }, { kind: "cloud" });

if (renderSkipped !== undefined) console.info(`composer slash menu render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the composer's slash menu and its line laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    // The centre column at the composer's full width, where the slot is as wide as it gets and a line is read whole; at
    // the narrowest centre the shell hands it (364px at a 1200px viewport with the panel open) every line in the slot
    // is cut and carries itself as its title, this one no more than the rest.
    page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const EDITOR = "[data-testid=composer-editor]";
  const ITEM = "[data-composer-command-drawer] [data-composer-item-id]";
  const LINE = "[data-composer-refusal] [role=status]";

  it.each(["dark", "light"] as const)("in the %s theme the menu lists what runs and no screen, and a typed screen command leaves one line and no turn", async theme => {
    await page!.goto(`${base}?theme=${theme}&ws=ws_a&chat=1`);
    await page!.waitForSelector(".chat-markdown");
    await page!.locator(EDITOR).click();
    await page!.keyboard.type("/");
    await page!.waitForSelector(ITEM);
    const names = await page!.locator(ITEM).evaluateAll(els => els.map(el => (el.getAttribute("data-composer-item-id") ?? "").split(":").pop()));
    expect(names).toEqual(RUNS);
    for (const screen of SCREENS) expect(names, `${screen} in the menu in ${theme}`).not.toContain(screen);
    // The menu is a layer over the box; the centre column holds both.
    const menuShot = join(SHOTS, `composer-slash-menu-${theme}.png`);
    await page!.locator("[data-shell-center]").screenshot({ path: menuShot });
    console.info(`composer slash menu screenshot: ${menuShot}`);

    await page!.keyboard.type("login");
    await page!.waitForSelector(ITEM, { state: "detached" });
    const turns = await page!.locator(".chat-markdown").count();
    await page!.keyboard.press("Enter");
    await page!.waitForSelector(LINE);
    expect(await page!.locator(LINE).textContent()).toBe(LOGIN_LINE);
    // Nothing went: the transcript holds what it held, the draft is still in the box, and the menu's empty state is gone.
    expect(await page!.locator(".chat-markdown").count()).toBe(turns);
    expect((await page!.locator(EDITOR).textContent()) ?? "").toBe("/login");
    expect(await page!.locator("[data-composer-command-drawer]").count()).toBe(0);
    // The slot's grammar: one muted mono sentence, no panel, no icon, whole on its line.
    const look = await page!.locator(LINE).evaluate(el => {
      const cs = getComputedStyle(el);
      const slot = el.closest("[data-composer-refusal]")!.getBoundingClientRect();
      return { font: cs.fontFamily.toLowerCase(), size: cs.fontSize, lines: Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight)), cut: el.scrollWidth > el.clientWidth, text: el.scrollWidth, room: el.clientWidth, slot: slot.width, icons: el.querySelectorAll("svg").length };
    });
    console.info(`${theme}: the line needs ${look.text}px of the ${look.room}px it has in a ${look.slot}px slot`);
    const lineShot = join(SHOTS, `composer-screen-command-${theme}.png`);
    await page!.locator("[data-chat-composer]").screenshot({ path: lineShot });
    console.info(`composer screen command screenshot: ${lineShot}`);
    expect(look.font).toMatch(/mono/);
    expect(look.lines).toBe(1);
    expect(look.cut, `the line is cut at the slot's width in ${theme}`).toBe(false);
    expect(look.icons).toBe(0);
    const [ratio] = await textContrast(page!, LINE);
    console.info(`${theme}: the line reads at ${ratio} to 1 in ${look.font} ${look.size}`);
    // Muted text, held to AA for the body size it is drawn at rather than the large-text floor.
    expect(ratio!, `the line reads at ${ratio} in ${theme}`).toBeGreaterThanOrEqual(4.5);
  }, 60_000);
});
