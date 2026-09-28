// SPDX-License-Identifier: AGPL-3.0-only
// A skill's SKILL.md in a real Chromium, through the renderer's restricted
// mode: a file out to fetch an image, run a script and open files on this
// computer draws no image, no script, no file chip and no link but the one
// web page and the one heading, shows the raw HTML as its own text, and asks
// nothing of the image's host while it renders. Run twice: an installed
// skill's preview and a skills.sh result's before install. Vite serves
// test/wireframe, so it runs only when asked for (WSP_RENDER=1).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (renderSkipped !== undefined) console.info(`skill preview render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("a skill's SKILL.md rendered restricted in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    base = `${vite.base}/test/wireframe/index.html`;
    browser = await launchRender();
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  /** The page with every request to example.test counted, and a manager at 480 to open a detail in. */
  const open = async (): Promise<{ asked: string[]; at: ReturnType<Page["locator"]> }> => {
    await page?.close();
    page = await browser!.newPage({ viewport: { width: 900, height: 5200 }, colorScheme: "dark" });
    const asked: string[] = [];
    await page.route(/example\.test|google\.com\/s2\/favicons/, route => {
      asked.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto(`${base}?screen=skill-preview&theme=dark`);
    await page.waitForSelector("[data-agents-row]");
    const at = page.locator('[data-agents-width="480"]');
    await at.locator("[data-segment]").filter({ has: page.locator('[aria-label="Skills"]') }).click();
    return { asked, at };
  };

  const eightFacts = async (at: ReturnType<Page["locator"]>, asked: string[]): Promise<void> => {
    const body = at.locator("[data-k=skill-preview-body]");
    await body.locator("h1").waitFor();
    // Give an image, had one been drawn, the time to be asked for.
    await page!.waitForTimeout(300);
    const read = await body.evaluate(el => ({
      imgs: el.querySelectorAll("img").length,
      scripts: el.querySelectorAll("script").length,
      chips: el.querySelectorAll("[data-markdown-copy]").length,
      text: el.textContent ?? "",
      anchors: [...el.querySelectorAll("a")].map(a => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: a.textContent })),
    }));
    expect(read.imgs).toBe(0);
    expect(read.scripts).toBe(0);
    expect(read.chips).toBe(0);
    expect(read.text).toContain('<img src="https://example.test/p.gif">');
    expect(read.text).toContain("<script>alert(1)</script>");
    expect(read.anchors.map(a => a.href)).toEqual(["https://skills.sh", "#usage"]);
    expect(read.anchors[0]).toMatchObject({ target: "_blank", rel: "noopener noreferrer" });
    for (const bad of ["./scripts/run.py", "/Users/zingzy/.zshrc", "file:///etc/hosts"]) expect(read.text, bad).toContain(bad);
    for (const word of ["run", "abs", "hosts"]) expect(read.text).toContain(word);
    // The image stands as its alt text and its address, and the inline path as plain code.
    expect(read.text).toContain("pixel https://example.test/p.gif");
    expect(await body.locator("code", { hasText: "/etc/hosts" }).count()).toBe(1);
    expect(asked).toEqual([]);
    // A link keeps the hover that says where it goes, favicon or none, so a label cannot hide its address.
    await body.locator("a", { hasText: "site" }).hover();
    await page!.locator("[data-slot=tooltip-popup]", { hasText: "https://skills.sh" }).waitFor({ timeout: 5_000 });
  };

  it("draws an installed skill's hostile SKILL.md as text but for one web link and one heading link, and fetches nothing", async () => {
    const { asked, at } = await open();
    await at.locator('[data-agents-row="skill-user-frontend-design"] [data-row-trigger]').click();
    await eightFacts(at, asked);
  });

  it("draws a skills.sh result's hostile SKILL.md before install the same way", async () => {
    const { asked, at } = await open();
    await at.locator("[data-k=agents-add]").click();
    await at.locator("[data-k=add-search]").fill("pdf");
    await at.locator("[data-k=add-search]").press("Enter");
    await at.locator('[data-add-row="anthropics/skills/pdf"] [data-row-trigger]').click();
    await eightFacts(at, asked);
  });
});
