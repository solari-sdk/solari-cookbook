// SPDX-License-Identifier: AGPL-3.0-only
// The recipe and the image's first build inside the Image card of a box's
// page, in a real Chromium, both themes, at 1280 by 800, on every step the
// harness stages: rows of 48 px with 18 px marks, 15 px names and 12 px mono
// facts, the disk meter inline after the tally on the steps that change the
// image's size with the estimate in the meter's tone, sizes coloured by weight
// in three hues an eye tells apart, state words that read at AA, nothing
// animating at rest and no badge; the meter's tooltip and its fill, the
// sign-ins with their marks, code and field, the agent's mono block, and the
// error states as themselves. Photographed at each. Runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { CLOUD_SETUP_WORDS, INIT_ROW_STATES, INIT_SIGN_IN_WORDS, MACHINE_ROW_LABEL, NETWORK_LOST_LINE, SIGN_IN_STAGE_ID, initSignInLine, initStepCounter } from "@wsp/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast, textHue } from "./contrast";
import { KEY_REFUSED_LINE } from "./fixtures/keyRefusedJob";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`image recipe layout render test skipped: ${renderSkipped}`);

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every step the harness stages, in the order a person meets them. */
const STEPS = ["choice", "agent", "agent-stopped", "reading", "agents", "tools", "also", "logins", "building", "signing", "retry", "failed", "failed-key", "stopped", "you-stopped", "sweeping", "slot", "over", "no-extras"] as const;
type StepName = (typeof STEPS)[number] | "many-tools";
const BUILDS = new Set<StepName>(["building", "signing", "retry", "failed", "failed-key", "stopped", "you-stopped", "sweeping", "slot"]);
/** The answer steps, which carry their count over the title. */
const COUNTED = new Set<StepName>(["agents", "tools", "also", "logins", "over", "no-extras"]);
/** The steps whose tally carries the disk meter: the ones that change the image's size. */
const METERED = new Set<StepName>(["agents", "tools", "also", "over", "no-extras"]);
const SPEC = { row: 48, mark: 18, name: 15, meta: 12, field: 32, meter: 64, meterLine: 2 } as const;
const VIEWPORT = { width: 1280, height: 800 } as const;

describe.skipIf(renderSkipped !== undefined)("the Image card's recipe and build laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/recipe/index.html");
    base = vite.base;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { ...VIEWPORT } });
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  const boxes = async (selector: string): Promise<Box[]> => {
    const out: Box[] = [];
    for (const l of await page!.locator(selector).all()) {
      const b = await l.boundingBox();
      if (!b) throw new Error(`${selector} has no box`);
      out.push(b);
    }
    return out;
  };
  const box = async (selector: string): Promise<Box> => {
    const [b] = await boxes(selector);
    if (b === undefined) throw new Error(`${selector} is not on the page`);
    return b;
  };
  const style = (selector: string, prop: string): Promise<string[]> => page!.locator(selector).evaluateAll((els, p) => els.map(el => getComputedStyle(el).getPropertyValue(p)), prop);
  const px = (value: string | undefined): number => Math.round(parseFloat(value ?? "0") * 100) / 100;
  const near = (a: number, b: number, tolerance = 2): boolean => Math.abs(a - b) <= tolerance;

  const shoot = async (step: string, theme: "dark" | "light"): Promise<void> => {
    const path = join(SHOTS, `image-recipe-${step}-${theme}.png`);
    await page!.locator("[data-settings-card=image]").screenshot({ path });
    console.info(`image recipe ${step} ${theme}: ${path}`);
  };

  /** The step's frame under the card: the recipe's, or the build's. */
  const goTo = async (step: StepName, theme: "dark" | "light"): Promise<string> => {
    await page!.goto(`${base}/test/recipe/index.html?theme=${theme}&screen=${step}`);
    const frame = `[data-settings-card=image] [data-k=${BUILDS.has(step) ? "build" : "recipe"}]`;
    await page!.waitForSelector(step === "choice" ? `${frame}[data-step=choice]` : frame);
    await page!.waitForTimeout(350);
    await page!.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    return frame;
  };

  it.each(["dark", "light"] as const)("in the %s theme every step's rows are 48 px with the marks, names and facts at their sizes, the meter after the tally where the step weighs, and words that read", async theme => {
    await page!.setViewportSize({ ...VIEWPORT });
    for (const step of STEPS) {
      const frame = await goTo(step, theme);
      expect(await page!.locator(`${frame} [data-k=${BUILDS.has(step) ? "build" : "recipe"}-counter]`).count(), `${step}: counter`).toBe(COUNTED.has(step) ? 1 : 0);
      const rows = await boxes(`${frame} [data-k=row] > div:first-child, ${frame} li[data-k=row]:not(:has(> div)), ${frame} [data-k=signin] > div:first-child`);
      for (const r of rows) expect(near(r.height, SPEC.row), `${step}: row height ${r.height}`).toBe(true);
      for (const m of await boxes(`${frame} [data-row-mark]`)) expect(near(m.width, SPEC.mark) && near(m.height, SPEC.mark), `${step}: mark ${m.width}x${m.height}`).toBe(true);
      expect(await page!.locator(`${frame} [data-row-mark]:not(svg)`).count(), `${step}: no drawn initials`).toBe(0);
      for (const n of await style(`${frame} [data-k=row] span[class*='text-[15px]']`, "font-size")) expect(px(n)).toBe(SPEC.name);
      for (const m of await style(`${frame} [data-k=size], ${frame} [data-k=why], ${frame} [data-k=state]:not([role=status]), ${frame} [data-k=tally]`, "font-size")) expect(px(m)).toBe(SPEC.meta);
      for (const f of await boxes(`${frame} [data-slot=input-control]`)) expect(near(f.height, SPEC.field), `${step}: field ${f.height}`).toBe(true);
      const meters = await boxes(`${frame} [data-k=disk]`);
      expect(meters.length, `${step}: meter`).toBe(METERED.has(step) ? 1 : 0);
      if (meters.length > 0) {
        const line = await box(`${frame} [data-k=disk] > span`);
        const tally = await box(`${frame} [data-k=tally]`);
        expect(near(line.width, SPEC.meter) && near(line.height, SPEC.meterLine), `${step}: meter ${line.width}x${line.height}`).toBe(true);
        expect(line.x, `${step}: the meter follows the words`).toBeGreaterThan(tally.x + 100);
        expect(await page!.locator(`${frame} [data-k=tally-size]`).textContent(), `${step}: the estimate against the disk`).toMatch(/^[\d.]+ (MB|GB) of 20 GB$/);
        expect(await page!.locator(`${frame} [data-k=tally-size]`).getAttribute("data-tone"), `${step}: the estimate in the meter's tone`).toBe(await page!.locator(`${frame} [data-k=disk]`).getAttribute("data-tone"));
      }
      const tones = await page!.locator(`${frame} [data-k=size]`).evaluateAll(els => els.map(el => el.getAttribute("data-tone")));
      for (const tone of tones) expect(["danger", "warning", "yellow", "muted"], `${step}: a size in ${tone}`).toContain(tone);
      if (step === "agents") expect(new Set(tones), "agents: muted sizes").toEqual(new Set(["muted"]));
      if (step === "tools") expect(new Set(tones), "tools: weighed sizes").toEqual(new Set(["muted", "yellow", "warning", "danger"]));
      expect(await page!.locator("[data-settings-card=image] [class*=animate-]:not([role=status]), [data-settings-card=image] [data-badge]").count(), `${step}: nothing animates at rest, no badge`).toBe(0);
      const words = await textContrast(page!, `${frame} [data-k=state], ${frame} [data-k=why], ${frame} [data-k=size], ${frame} [data-k=tally], ${frame} [data-k=tally-size], ${frame} [data-k$=-counter], ${frame} [data-k$=-sentence]`);
      for (const ratio of words) expect(ratio, `${step}: words read`).toBeGreaterThanOrEqual(4.5);
      expect(await page!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${step}: nothing wider than the window`).toBe(true);
      await shoot(step, theme);
    }
  }, 240_000);

  it.each(["dark", "light"] as const)("in the %s theme the longest screen is drawn whole: the page scrolled to its end shows every one of its 31 rows on the way, and Continue at the end", async theme => {
    const frame = await goTo("many-tools", theme);
    const scroller = page!.locator("[data-settings-page]").locator("xpath=ancestor::*[@data-slot='scroll-area-viewport'][1]");
    expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight), "the page is taller than the window").toBe(true);
    const seen = new Set<string>();
    const look = (): Promise<string[]> =>
      page!.locator(`${frame} [data-k=row][data-row]`).evaluateAll(els =>
        els.flatMap(el => {
          const b = el.getBoundingClientRect();
          const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return b.top >= 0 && b.bottom <= window.innerHeight && hit !== null && el.contains(hit) ? [el.getAttribute("data-row")!] : [];
        }),
      );
    for (let at = 0; ; at += 200) {
      const moved = await scroller.evaluate((el, y) => {
        el.scrollTop = y;
        return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      }, at);
      await page!.waitForTimeout(30);
      for (const id of await look()) seen.add(id);
      if (!moved) break;
    }
    expect([...seen].sort(), "every row seen as the page scrolls").toEqual(Array.from({ length: 31 }, (_, i) => `tool-${i}`).sort());
    const keycap = await box(`${frame} [data-k=recipe-primary]`);
    expect(keycap.y + keycap.height, "Continue in the window at the page's end").toBeLessThanOrEqual(800);
    expect(await page!.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-k=recipe-primary]") !== null, { x: keycap.x + keycap.width / 2, y: keycap.y + keycap.height / 2 }), "and nothing over it").toBe(true);
    await page!.locator("[data-settings-card=image]").screenshot({ path: join(SHOTS, `image-recipe-many-tools-${theme}.png`) });
  });

  it.each(["dark", "light"] as const)("in the %s theme at a phone's width the road choice cuts nothing: the agent road's name keeps its words and its picker drops under it", async theme => {
    await page!.setViewportSize({ width: 390, height: 844 });
    const frame = await goTo("choice", theme);
    const cut = await page!.locator(`${frame} *`).evaluateAll(els => els.filter(el => el.children.length === 0 && (el.textContent ?? "").trim() !== "" && el.scrollWidth > el.clientWidth + 1).map(el => el.textContent));
    expect(cut, "no words on the road choice are cut").toEqual([]);
    const name = await box(`${frame} [data-k=road-agent] ~ span`);
    const picker = await box(`${frame} [data-k=harness]`);
    expect(picker.y, "the picker under the name").toBeGreaterThanOrEqual(name.y + name.height - 1);
    await page!.locator("[data-settings-card=image]").screenshot({ path: join(SHOTS, `image-recipe-choice-390-${theme}.png`) });
    await page!.setViewportSize({ ...VIEWPORT });
  });

  it.each(["dark", "light"] as const)("in the %s theme a run with no extras step counts its first step 1/3, the screens the person sees", async theme => {
    const frame = await goTo("no-extras", theme);
    expect(await page!.locator(`${frame} [data-k=recipe-counter]`).textContent()).toBe(initStepCounter(1, 3));
  });

  it.each(["dark", "light"] as const)("in the %s theme the error states read as themselves: the sentence a stopped build gives, the cap wait on its own row, the list kept in order, the machine left running as a row, and the refusal past the disk in the meter's tone", async theme => {
    let frame = await goTo("stopped", theme);
    // The build stands in the state row's place and says why it stopped itself.
    expect(await page!.locator("[data-settings-card=image] [data-k=image-state]").count()).toBe(0);
    expect(await page!.locator(`${frame} [data-k=build-sentence]`).textContent()).toBe(NETWORK_LOST_LINE);
    expect(await page!.locator(`${frame} [data-k=build-title]`).textContent()).toBe(CLOUD_SETUP_WORDS.build.failed);
    const listed = await page!.locator(`${frame} [data-k=row]`).evaluateAll(els => els.map(el => el.getAttribute("data-row")));
    expect(listed, "the list keeps its order and its rows").toEqual(["stage/creating", "stage/deploying-daemon", "stage/applying-setup", "stage/uploading-files", "stage/installing-harness", "stage/installing-tools", "stage/installing-mcp", "stage/ready", "stage/snapshotting", "stage/promoting", "stage/smoke-forking", "stage/sealed"]);
    expect(await page!.locator(`${frame} [data-row="stage/applying-setup"] [data-k=lines]`).textContent()).toMatch(new RegExp(`${NETWORK_LOST_LINE}$`));

    frame = await goTo("you-stopped", theme);
    expect(await page!.locator(`${frame} [data-k=build-title]`).textContent()).toBe(CLOUD_SETUP_WORDS.build.stopped);
    expect(await page!.locator(`${frame} [data-row="stage/deploying-daemon"] [data-k=state]`).textContent()).toBe(INIT_ROW_STATES.stopped);
    expect(await page!.locator(`${frame} [data-row="stage/deploying-daemon"] [data-glyph=failed]`).count(), "no cross in the glyph").toBe(0);

    frame = await goTo("sweeping", theme);
    const machine = `${frame} [data-row="machine/b_dlb9oeig"]`;
    expect(await page!.locator(`${machine} [data-k=state]`).textContent()).toBe(INIT_ROW_STATES.retrying);
    expect(await page!.locator(machine).textContent()).toContain(MACHINE_ROW_LABEL);
    expect(await page!.locator("[data-settings-card=image]").textContent(), "no provider id on the card").not.toMatch(/b_dlb9oeig|b_dlbauaeb/);
    expect(near((await box(`${machine} > div:first-child`)).height, SPEC.row), "the machine row is a row").toBe(true);
    expect(await page!.locator(`${frame} [data-row="machine/b_dlbauaeb"] [data-k=state]`).textContent()).toBe(INIT_ROW_STATES.gone);
    for (const ratio of await textContrast(page!, `${machine} [data-k=state]`)) expect(ratio, "the machine's word reads").toBeGreaterThanOrEqual(4.5);

    frame = await goTo("slot", theme);
    expect(await page!.locator(`${frame} [data-row="stage/creating"] [data-k=state]`).textContent()).toBe(INIT_ROW_STATES.slot);
    expect(await page!.locator(`${frame} [data-row="stage/creating"] [data-k=lines]`).textContent()).toContain("at its machine cap");

    frame = await goTo("over", theme);
    expect(await page!.locator(`${frame} [data-k=disk]`).getAttribute("data-tone")).toBe("danger");
    expect(await page!.locator(`${frame} [data-k=disk-over]`).count(), "no third line beside the tally").toBe(0);
    expect(await page!.locator(`${frame} [data-k=disk]`).getAttribute("aria-label")).toMatch(/, over by [\d.]+ (MB|GB)$/);
    const cardBefore = await box(`${frame} [data-k=card]`);
    await page!.click(`${frame} [data-k=recipe-primary]`);
    await page!.waitForFunction(() => (document.querySelector("[data-k=recipe-refusal]")?.textContent ?? "") !== "");
    const cardAfter = await box(`${frame} [data-k=card]`);
    expect([cardAfter.y, cardAfter.height], "the card stands where it stood").toEqual([cardBefore.y, cardBefore.height]);
    const [tone, fillTone] = await page!.evaluate(() => [getComputedStyle(document.querySelector("[data-k=recipe-refusal]")!).color, getComputedStyle(document.querySelector("[data-k=disk-fill]")!).backgroundColor]);
    expect(tone, "the refusal wears the meter's tone").toBe(fillTone);
    expect((await textContrast(page!, `${frame} [data-k=recipe-refusal]`))[0], "the refusal reads at AA").toBeGreaterThanOrEqual(4.5);
    await shoot("over-refused", theme);
  }, 240_000);

  it.each(["dark", "light"] as const)("in the %s theme the three weight tones are told apart by hue alone: the yellow at least 20 degrees of oklch hue cooler than the orange, the orange at least 20 cooler than the red, each cell reading at AA", async theme => {
    const frame = await goTo("tools", theme);
    const hue = async (tone: string): Promise<number> => (await textHue(page!, `${frame} [data-k=size][data-tone=${tone}]`))[0]!;
    const [yellow, orange, red] = [await hue("yellow"), await hue("warning"), await hue("danger")];
    expect(yellow - orange, `${theme}: yellow ${yellow} against orange ${orange}`).toBeGreaterThanOrEqual(20);
    expect(orange - red, `${theme}: orange ${orange} against red ${red}`).toBeGreaterThanOrEqual(20);
    for (const ratio of await textContrast(page!, `${frame} [data-k=size]`)) expect(ratio, `${theme}: a size reads`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["dark", "light"] as const)("in the %s theme the meter's tooltip reads the numbers, its fill grows with a tick, and the sign-ins carry a mark each, the waiting one its page and code in 20 px mono, and the one whose page hands a code back a mono field under it", async theme => {
    let frame = await goTo("agents", theme);
    const fill = page!.locator(`${frame} [data-k=disk-fill]`);
    const before = (await fill.boundingBox())!.width;
    await page!.locator(`${frame} [data-row="hermes"] [role=checkbox]`).click();
    await page!.waitForTimeout(400);
    expect((await fill.boundingBox())!.width).toBeGreaterThan(before);
    await page!.locator(`${frame} [data-k=disk]`).hover();
    const tip = page!.locator("[data-slot=tooltip-popup]");
    await tip.waitFor();
    expect(await tip.textContent()).toMatch(/^about [\d.]+ GB of 20 GB on the image$/);
    expect(await style("[data-slot=tooltip-popup]", "font-size")).toEqual(["13px"]);
    await page!.mouse.move(0, 0);

    frame = await goTo("signing", theme);
    expect(await page!.locator(`${frame} [data-k=build-title]`).textContent()).toBe(CLOUD_SETUP_WORDS.build.slideHeadline);
    expect(await page!.locator(`${frame} [data-row^='agent/']`).count(), "no MCP rows").toBe(0);
    const slideRows = await page!.locator(`${frame} [data-k=signin]`).evaluateAll(els =>
      els.map(el => {
        const line = el.firstElementChild!.getBoundingClientRect();
        return { row: el.getAttribute("data-row"), acts: el.getAttribute("data-acts"), height: el.getBoundingClientRect().height, line: line.height, lineY: line.y, act: el.querySelector("[data-k=act]")?.getBoundingClientRect().height ?? 0, name: el.querySelector("span[class*='text-[15px]']")!.getBoundingClientRect().x, stateY: el.querySelector("[data-k=state]")!.getBoundingClientRect().y };
      }),
    );
    expect(slideRows.length).toBe(5);
    for (const r of slideRows) {
      expect(near(r.line, SPEC.row), `${r.row}: line ${r.line}`).toBe(true);
      if (r.acts === "true") expect(r.act, `${r.row}: an action line`).toBeGreaterThanOrEqual(40 - 1);
      expect(r.stateY >= r.lineY - 1 && r.stateY < r.lineY + SPEC.row, `${r.row}: the state word on the name's line`).toBe(true);
    }
    expect(slideRows.filter(r => r.acts === "true").map(r => r.row)).toEqual(["sign-in/gh", "sign-in/wrangler", "sign-in/gcloud"]);
    expect(new Set(slideRows.map(r => Math.round(r.name))).size, "names start at one x").toBe(1);
    expect((await style(`${frame} [data-k=signin] [data-k=code]`, "font-size"))[0]).toBe("20px");
    const cut = await page!.locator(`${frame} [data-k=signin] *`).evaluateAll(els => els.filter(el => el.children.length === 0 && (el.textContent ?? "").trim() !== "" && el.scrollWidth > el.clientWidth + 1).map(el => el.textContent));
    expect(cut, "no text on the sign-ins is cut").toEqual([]);
    expect(await page!.locator(`${frame} [data-k=card]`).textContent()).not.toMatch(/exited|codex login|wrangler login/);
    expect(await page!.locator(`${frame} [data-row="sign-in/gh"] [data-k=why]`).textContent()).toBe(initSignInLine({ state: INIT_ROW_STATES.open, code: "8F4A-C21B" }));
    expect(await page!.locator(`${frame} [data-row="sign-in/gh"] [data-k=open]`).getAttribute("href")).toBe("https://github.com/login/device");
    expect(await page!.locator(`${frame} [data-row^='sign-in/'] [data-row-mark]`).count()).toBe(4);
    const codeField = await box(`${frame} [data-row="sign-in/gcloud"] [data-k=code-field]`);
    const gcloudLine = await box(`${frame} [data-row="sign-in/gcloud"] > div:first-child`);
    expect(codeField.y, "the field sits under the row's own line").toBeGreaterThanOrEqual(gcloudLine.y + gcloudLine.height - 1);
    expect((await style(`${frame} [data-k=code-field]`, "font-family"))[0]!.toLowerCase(), "mono, as a code is read").toMatch(/mono|menlo|consolas/);
    await shoot("signing-slide", theme);

    frame = await goTo("retry", theme);
    expect(await page!.locator(`${frame} [data-row='${SIGN_IN_STAGE_ID}'][data-open=true]`).count()).toBe(1);
    expect(await page!.locator(`${frame} [data-row='${SIGN_IN_STAGE_ID}'] [data-glyph]`).first().getAttribute("data-glyph")).toBe("failed");
    expect(await page!.locator(`${frame} [data-row='${SIGN_IN_STAGE_ID}'] > div [data-k=state]`).textContent()).toBe(INIT_SIGN_IN_WORDS["not-signed-in"]("darwin"));
    expect(await page!.locator(`${frame} [data-row='sign-in/gh'] [data-k=retry]`).count()).toBe(1);
    expect(await page!.locator(`${frame} [data-k=build-cancel]`).isDisabled()).toBe(true);
    expect(await page!.locator(`${frame} [data-k=build-refusal]`).textContent()).toBe(CLOUD_SETUP_WORDS.build.cannotStop);
    const card = await box(`${frame} [data-k=card]`);
    const line = await box(`${frame} [data-k=progress]`);
    expect(near(line.height, 2) && near(line.y - card.y, 1) && near(line.width, card.width - 2), `progress ${line.width}x${line.height} at ${line.y - card.y}`).toBe(true);
    const one = await box(`${frame} [data-row='stage/snapshotting'] [data-k=lines]`);
    expect(near(one.height, 36), `one line, block ${one.height}`).toBe(true);
    expect((await style(`${frame} [data-k=elapsed]`, "font-family"))[0]!.toLowerCase()).toMatch(/mono|menlo|consolas/);

    frame = await goTo("building", theme);
    const block = await box(`${frame} [data-k=lines]`);
    expect(near(block.height, 176), `block ${block.height}`).toBe(true);
    const scroller = page!.locator(`${frame} [data-k=lines-scroll]`);
    expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollTop > 0), "scrolls, pinned to the newest line").toBe(true);
    expect(await page!.locator(`${frame} [data-k=lines] span[class*='--terminal-ansi-2']`).count(), "the machine's green, from the pane's own palette").toBeGreaterThan(0);
    expect(await page!.locator(`${frame} [data-k=lines] span[class*='opacity-60']`).count(), "the tool prefix dimmed").toBeGreaterThan(0);
  }, 120_000);

  it.each(["dark", "light"] as const)("in the %s theme the agent step is the thread's own line in a mono block with the spinner and the link into it; once the turn stopped the spinner goes and Retry and Start over stand in its foot", async theme => {
    let frame = await goTo("agent", theme);
    expect((await style(`${frame} [data-k=line]`, "font-family"))[0]!.toLowerCase(), "mono, as the build's stage lines are").toMatch(/mono|menlo|consolas/);
    expect(await page!.locator(`${frame} [data-k=line]`).textContent()).toBe("read /Users/zingzy/.claude/projects");
    expect(await page!.locator(`${frame} [data-k=spinner]`).count(), "the spinner says the thread is working").toBe(1);
    expect(await page!.locator(`${frame} [data-k=open-thread]`).textContent()).toBe(CLOUD_SETUP_WORDS.agent.open);
    expect(await page!.locator(`${frame} [data-k=recipe-primary]`).count(), "nothing to press while it works").toBe(0);
    frame = await goTo("agent-stopped", theme);
    await page!.waitForSelector(`${frame}[data-step=agent]`);
    expect(await page!.locator(`${frame} [data-k=recipe-title]`).textContent()).toBe(CLOUD_SETUP_WORDS.agent.failed);
    expect(await page!.locator(`${frame} [data-k=recipe-sentence]`).textContent()).toContain("recipe.json");
    expect(await page!.locator(`${frame} [data-k=spinner]`).count()).toBe(0);
    expect(await page!.locator(`${frame} [data-k=recipe-primary]`).textContent()).toBe(CLOUD_SETUP_WORDS.agent.retry);
    expect(await page!.locator(`${frame} [data-k=recipe-again]`).textContent()).toBe(CLOUD_SETUP_WORDS.agent.again);
  }, 60_000);

  it.each(["dark", "light"] as const)("in the %s theme a saved key refused at build time reads nothing as done and offers Change the key", async theme => {
    const frame = await goTo("failed-key", theme);
    expect(await page!.locator(`${frame} [data-k=build-title]`).textContent()).toBe(CLOUD_SETUP_WORDS.build.failed);
    expect(await page!.locator(`${frame} [data-k=build-primary]`).textContent()).toBe(CLOUD_SETUP_WORDS.keys.changeKey);
    expect(await page!.locator(`${frame} [data-k=progress]`).getAttribute("aria-valuenow")).toBe("0");
    expect(await page!.locator(`${frame} [data-row="stage/creating"] [data-k=lines]`).textContent()).toContain(KEY_REFUSED_LINE);
    expect(await page!.locator(`${frame} [data-row="${SIGN_IN_STAGE_ID}"]`).getAttribute("data-state")).toBe(INIT_ROW_STATES.skipped);
    expect(await page!.locator(`${frame} [data-row][data-state="${INIT_ROW_STATES.done}"]`).count(), "no row reads done").toBe(0);
    for (const row of [SIGN_IN_STAGE_ID, "workspace/first"]) expect(await page!.locator(`${frame} [data-row="${row}"] [data-k=glyph] svg`).count(), `${row} wears no check`).toBe(0);
  });
});
