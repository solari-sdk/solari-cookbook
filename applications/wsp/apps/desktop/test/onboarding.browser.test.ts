// SPDX-License-Identifier: AGPL-3.0-only
// The first launch in a real Chromium, loaded as the file it ships as with the
// web app's built stylesheet and the agents' glyphs written in as stage.mjs
// writes them, and the shell's bridge faked. Two screens: a welcome of the
// mark alone over Get started, the tilde a flat stroke with one thin light
// along its top edge and one thin shade along its bottom, drawn by CSS alone;
// then the agents screen, one row per catalog agent, the found ones ticked and
// the missing ones held, Open wsp held until one is ticked, and Check again
// where none was found. Each is frozen and photographed in both appearances,
// and no focus ring sits at rest however a screen was reached. Like the web's
// render tests it runs only when asked for (WSP_RENDER=1) and skips without
// Playwright's Chromium.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, CDPSession, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "../../web/test/render-browser.js";
import { writeGlyphs } from "../scripts/glyphs.mjs";

const DESKTOP = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(DESKTOP, "..", "web");
const SHOTS = join(DESKTOP, "artifacts", "render");
/** The onboarding window's size, from window.ts. */
const WINDOW = { width: 1280, height: 800 };
/** The size the mocks were rendered at, so a judge lays a shot beside the mock of the same name. */
const JUDGE = { width: 1440, height: 1000 };
/** Where the welcome is frozen: before anything, while the tilde is drawn and before its edge lights, and past every end. */
const FRAMES = { "0ms": 0, "500ms": 500, rest: 3000 } as const;
/** An edge is one luma step or more off the body; a rim is this many units of the mark tall at most. */
const EDGE_STEP = 6;
const RIM_UNITS = 0.4;

/** The catalog's agents as one computer might have them: two here, three the scan did not find. */
const AGENTS = [
  { id: "claude", name: "Claude Code", found: true, configured: false },
  { id: "codex", name: "Codex", found: true, configured: false },
  { id: "gemini", name: "Gemini CLI", found: false, configured: false },
  { id: "hermes", name: "Hermes", found: false, configured: false },
  { id: "opencode", name: "OpenCode", found: false, configured: false },
  { id: "crush", name: "Crush", found: false, configured: false },
];

/** The words the agents screen says under its card and on its keycap. */
const LINES = {
  some: "Agents you install later get the tools from Settings.",
  noneTicked: "Tick at least one agent. wsp works through the agents you give it.",
  noneFound: "No agent found on this Mac. Install Claude Code or Codex, then press Check again.",
};
const TOOLS_FIX = "Take the tick off that agent, or fix its config and press again.";

/** The page as stage.mjs lays it out: the web app's own built stylesheet and the agents' glyphs written in. */
function stagePage(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-onboarding-render-"));
  const assets = join(WEB, "dist", "assets");
  const css = readdirSync(assets).find(f => /^index-.*\.css$/.test(f));
  if (css === undefined) throw new Error(`the web app is not built: no stylesheet under ${assets}`);
  const ids = writeGlyphs(join(dir, "agents"));
  const page = readFileSync(join(DESKTOP, "src", "onboarding.html"), "utf8").replace("__WEB_CSS__", pathToFileURL(join(assets, css)).href).replace("__AGENT_GLYPHS__", JSON.stringify(ids));
  writeFileSync(join(dir, "onboarding.html"), page);
  return dir;
}

/** The shell's bridge, answered in the page: the fixture's agents and an install that lands every id. */
const bridge = (agents: ReadonlyArray<{ id: string; name: string; found: boolean; configured: boolean }> = AGENTS): string => `window.wsp = {
  agents: async () => ${JSON.stringify(agents)},
  install: async ids => { window.__installed = ids; return { installed: ids.map(id => ({ id })), failures: [] }; },
  finish: async () => { window.__opened = true; },
};`;
const NO_AGENTS = bridge(AGENTS.map(a => ({ ...a, found: false })));
/** None found on the first read, then the two installed while the screen waited: what Check again is for. */
const FOUND_ON_SECOND_READ = `${bridge()}
let reads = 0;
const later = window.wsp.agents;
window.wsp.agents = async () => (++reads === 1 ? ${JSON.stringify(AGENTS.map(a => ({ ...a, found: false })))} : later());`;
/** A read of this computer's agents that throws. */
const UNREAD = `${bridge()}\nwindow.wsp.agents = async () => { throw new Error("Error invoking remote method 'agents': Error: EACCES: permission denied"); };`;
/** The catalog's six agents, every one here: the most names one refusal can ever have to carry. */
const SIX = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "opencode", name: "OpenCode" },
  { id: "pi", name: "Pi" },
  { id: "hermes", name: "Hermes" },
].map(a => ({ ...a, found: true, configured: false }));
const REFUSE_EVERY = `window.wsp.install = async ids => ({ installed: [], failures: ids.map(id => ({ id, error: "~/." + id + ".json: EACCES: permission denied" })) });`;
/** A scan slow enough to be read before it lands, which is a first launch on a disk that has gone to sleep. */
const SLOW_SCAN = `${bridge()}
const land = window.wsp.agents;
window.wsp.agents = () => new Promise(done => setTimeout(() => done(land()), 1500));`;
const TOOLS_REFUSED = `${bridge()}\n${REFUSE_EVERY}`;
const SIX_REFUSED = `${bridge(SIX)}\n${REFUSE_EVERY}`;

if (renderSkipped !== undefined) console.info(`onboarding render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the first launch laid out in Chromium", { timeout: 20_000 }, () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let cdp: CDPSession | undefined;
  let staged = "";
  let url = "";

  beforeAll(async () => {
    staged = stagePage();
    url = pathToFileURL(join(staged, "onboarding.html")).href;
    browser = await launchRender();
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await stopRender(browser, undefined);
    rmSync(staged, { recursive: true, force: true });
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  /** Whether the scan has answered: the line under the card, or the refusal slot, holds words. */
  const scanned = (): Promise<unknown> => page!.waitForFunction(() => (document.querySelector("#line")?.textContent ?? "") !== "" || (document.querySelector("#status")?.textContent ?? "") !== "");

  /** A fresh page in one appearance, its animations held at their start so a frame is a fact and not a race. */
  async function open(theme: "dark" | "light", reducedMotion: "reduce" | "no-preference" = "no-preference", init = bridge(), viewport = WINDOW, wait = true): Promise<Page> {
    page = await browser!.newPage({ viewport, colorScheme: theme, reducedMotion });
    await page.addInitScript(init);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
    await page.goto(url);
    await page.waitForFunction(t => document.documentElement.classList.contains("dark") === (t === "dark"), theme);
    if (wait) await scanned();
    return page;
  }

  /** The same page moved on to the agents screen by its one button. */
  async function agents(theme: "dark" | "light", reducedMotion: "reduce" | "no-preference" = "reduce", init = bridge(), viewport = WINDOW): Promise<Page> {
    await open(theme, reducedMotion, init, viewport);
    await page!.click("#start");
    await settle();
    return page!;
  }

  /** Every animation on the page seeked to one moment. */
  const seek = (ms: number): Promise<void> =>
    page!.evaluate(t => {
      for (const a of document.getAnimations()) a.currentTime = t;
    }, ms);

  /** Every animation seeked past its end, which is the page at rest. */
  const settle = (): Promise<void> => seek(FRAMES.rest);

  /** The rgb of the pixels the photograph holds at each point, read back through a canvas in the page. */
  async function pixels(file: string, points: Array<{ x: number; y: number }>): Promise<number[][]> {
    const png = readFileSync(file).toString("base64");
    return page!.evaluate(
      ([data, pts]) =>
        new Promise<number[][]>(done => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            done(pts.map(p => [...ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data.slice(0, 3)]));
          };
          img.src = `data:image/png;base64,${data}`;
        }),
      [png, points] as const,
    );
  }

  const luma = ([r, g, b]: number[]): number => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;

  /** The lumas along a line of pixels, one per step from `from` to `to`. */
  async function lumas(file: string, from: { x: number; y: number }, to: { x: number; y: number }): Promise<number[]> {
    const steps = Math.round(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)));
    const points = Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }));
    return (await pixels(file, points)).map(luma);
  }

  /** A line of pixels across the stroke, read as the stroke is meant to be built: the run on the stroke, told from the
   * ground by the first pixel's luma; the body, its median; the edge runs, how many pixels at each end sit one step
   * or more off the body, and which way, read one pixel in from the antialiased border; and the spread of the middle
   * 60 percent. */
  function stroke(line: number[]): { body: number; lead: number; trail: number; leadLuma: number; trailLuma: number; spread: number } {
    console.info(`lumas: ${line.map(l => Math.round(l)).join(" ")}`);
    const ground = line[0]!;
    const first = line.findIndex(l => Math.abs(l - ground) > 24);
    const last = line.length - 1 - [...line].reverse().findIndex(l => Math.abs(l - ground) > 24);
    expect(first).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(first + 8);
    const on = line.slice(first, last + 1);
    const body = [...on].sort((a, b) => a - b)[Math.floor(on.length / 2)]!;
    const off = (l: number): boolean => Math.abs(l - body) > EDGE_STEP;
    const lead = on.findIndex(l => !off(l));
    const trail = [...on].reverse().findIndex(l => !off(l));
    const middle = on.slice(Math.round(on.length * 0.2), Math.round(on.length * 0.8));
    return { body, lead, trail, leadLuma: on[1]!, trailLuma: on[on.length - 2]!, spread: Math.max(...middle) - Math.min(...middle) };
  }

  const opacity = (selector: string): Promise<number> => page!.$eval(selector, el => Number(getComputedStyle(el).opacity));
  const floodOpacity = (selector: string): Promise<number> => page!.$eval(selector, el => Number(getComputedStyle(el).floodOpacity));
  const dashOffset = (selector: string): Promise<number> => page!.$eval(selector, el => parseFloat(getComputedStyle(el).strokeDashoffset));
  const focusRing = (selector: string): Promise<{ visible: boolean; outline: string }> => page!.$eval(selector, el => ({ visible: el.matches(":focus-visible"), outline: getComputedStyle(el).outlineStyle }));
  /** The muted ink, read off the sentence, which every quiet word on the agents screen shares. */
  const mutedInk = (): Promise<string> => page!.$eval("#agents .sentence", el => getComputedStyle(el).color);
  const box = (selector: string): Promise<{ x: number; y: number; w: number; h: number }> => page!.$eval(selector, el => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }));
  const visible = (selector: string): Promise<boolean> => page!.isVisible(selector);
  /** Each row of the card as a person reads it: the name, the word in its slot, and its tick. */
  const rows = (): Promise<Array<{ name: string; state: string; checked: boolean; disabled: boolean; mark: string }>> =>
    page!.$$eval("#rows .row", els =>
      els.map(el => {
        const check = el.querySelector("input")!;
        const glyph = el.querySelector<HTMLElement>(".glyph");
        return { name: el.querySelector(".name")!.textContent ?? "", state: el.querySelector(".state")!.textContent ?? "", checked: check.checked, disabled: check.disabled, mark: glyph === null ? (el.querySelector(".initial")?.textContent ?? "") : getComputedStyle(glyph).backgroundColor === "rgba(0, 0, 0, 0)" ? `unpainted ${glyph.dataset["agent"]}` : (glyph.dataset["agent"] ?? "") };
      }),
    );
  const keycap = (): Promise<string> => page!.$eval("#open", el => (el.textContent ?? "").replace(/→/, "").trim());

  /** The three inks a refusal can be drawn in, as this appearance computes each token. */
  const tokenInks = (): Promise<{ destructive: string; foreground: string; muted: string }> =>
    page!.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const of = (name: string) => {
        const probe = document.createElement("span");
        probe.style.color = root.getPropertyValue(name);
        document.body.append(probe);
        const read = getComputedStyle(probe).color;
        probe.remove();
        return read;
      };
      return { destructive: of("--destructive-foreground"), foreground: of("--foreground"), muted: of("--muted-foreground") };
    });

  it.each(["dark", "light"] as const)("in the %s appearance the welcome is the mark alone over Get started: the tilde about 256 px across, centred, a flat stroke with a thin light along its top edge and a thin shade along its bottom", async theme => {
    await open(theme);
    await settle();
    expect(await visible("#welcome")).toBe(true);
    expect(await visible("#agents")).toBe(false);
    // No headline, no sentence: the mark and one button.
    expect(await page!.$$eval("#welcome h1, #welcome p", els => els.length)).toBe(0);
    expect(await page!.$$eval("#welcome button", els => els.map(el => el.id))).toEqual(["start"]);
    expect(await page!.$eval("#start", el => (el.textContent ?? "").replace(/→/, "").trim())).toBe("Get started");
    // The mark's own geometry, before its stroke: 12.8 of 16 units in a 320 px box, so the drawn tilde is 256 px across.
    const body = await page!.$eval("#welcome .tilde .body path", el => {
      const r = el.getBoundingClientRect();
      return { width: r.width, centre: r.left + r.width / 2, top: r.top, height: r.height, left: r.left };
    });
    expect(body.width).toBeGreaterThan(250);
    expect(body.width).toBeLessThan(262);
    expect(Math.abs(body.centre - WINDOW.width / 2)).toBeLessThan(1);
    expect(await page!.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    // The edges are cut from the stroke's own alpha: one path in the current colour, two offsets of it, no blur, no
    // drop shadow, no gradient, no second path.
    expect(await page!.$eval("#welcome .tilde", svg => svg.querySelectorAll("linearGradient, radialGradient, feDropShadow, feGaussianBlur, mask, use").length)).toBe(0);
    expect(await page!.$eval("#welcome .tilde", svg => svg.querySelectorAll("path").length)).toBe(1);
    expect(await page!.$eval("#welcome .tilde", svg => svg.querySelectorAll("feOffset").length)).toBe(2);
    expect(await page!.$eval("#welcome .tilde .body path", el => getComputedStyle(el).stroke)).toBe((await tokenInks()).foreground);
    expect(await focusRing("#start")).toEqual({ visible: false, outline: "none" });
    const file = join(SHOTS, `onboarding-welcome-${theme}-rest.png`);
    await page!.screenshot({ path: file });
    const unit = body.width / 12.8;
    // Down through the first hump's crown: its top pixels are lighter than the body and its bottom pixels darker,
    // each run under 0.4 units, and the middle 60 percent is one flat luma: no tube.
    const crownX = body.left + 3.2 * unit;
    const column = stroke(await lumas(file, { x: crownX, y: body.top - 2.2 * unit }, { x: crownX, y: body.top + 2.2 * unit }));
    const rim = RIM_UNITS * unit + 1;
    expect(column.leadLuma).toBeGreaterThan(column.body + EDGE_STEP);
    expect(column.lead).toBeLessThanOrEqual(rim);
    expect(column.trailLuma).toBeLessThan(column.body - EDGE_STEP);
    expect(column.trail).toBeLessThanOrEqual(rim);
    expect(column.spread).toBeLessThan(EDGE_STEP);
    // Across the join, where the stroke runs steeply: each edge thinner than at the crown, one flat body between.
    const joinY = body.top + body.height / 2;
    const across = stroke(await lumas(file, { x: body.left + 4.4 * unit, y: joinY }, { x: body.left + 8.4 * unit, y: joinY }));
    expect(across.lead).toBeLessThan(column.trail);
    expect(across.trail).toBeLessThan(column.lead);
    expect(across.spread).toBeLessThan(EDGE_STEP);
    expect(Math.abs(across.body - column.body)).toBeLessThan(EDGE_STEP);
  });

  it.each(["dark", "light"] as const)("in the %s appearance the agents screen is one row per catalog agent, the found ones first and ticked, the missing ones held, at the sheet screen's numbers", async theme => {
    await agents(theme);
    expect(await visible("#welcome")).toBe(false);
    expect(await visible("#agents")).toBe(true);
    expect(await page!.textContent("#agents h1")).toBe("Your agents drive wsp");
    expect(await page!.textContent("#agents .sentence")).toBe("Each ticked agent gets the wsp tools and skill, so it can open threads and tasks on this Mac.");
    expect(await rows()).toEqual([
      { name: "Claude Code", state: "on this Mac", checked: true, disabled: false, mark: "claude" },
      { name: "Codex", state: "on this Mac", checked: true, disabled: false, mark: "codex" },
      { name: "Gemini CLI", state: "not installed", checked: false, disabled: true, mark: "gemini" },
      { name: "Hermes", state: "not installed", checked: false, disabled: true, mark: "hermes" },
      { name: "OpenCode", state: "not installed", checked: false, disabled: true, mark: "opencode" },
      // An agent with no glyph beside the page draws its initial.
      { name: "Crush", state: "not installed", checked: false, disabled: true, mark: "C" },
    ]);
    expect(await page!.textContent("#line")).toBe(LINES.some);
    expect(await keycap()).toBe("Open wsp");
    expect(await page!.isEnabled("#open")).toBe(true);
    // A missing agent's name is in the muted ink; a found one's is not.
    const names = await page!.$$eval("#rows .name", els => els.map(el => getComputedStyle(el).color));
    expect(names[2]).toBe(await mutedInk());
    expect(names[0]).not.toBe(await mutedInk());
    // The 560 px column, the head's 64 px to the card, 48 px rows in one hairline card, the hint's 12 px, the
    // footer's 56 px to the 40 px keycap.
    expect((await box("#agents")).w).toBe(560);
    const head = await box("#agents .head");
    const card = await box("#rows");
    expect(Math.round(card.y - (head.y + head.h))).toBe(64);
    expect(await page!.$$eval("#rows .row", els => els.map(el => el.getBoundingClientRect().height))).toEqual(AGENTS.map(() => 48));
    // The hairline between rows sits inside each 48 px row; the card's own border adds one pixel over and under.
    expect(card.h).toBe(AGENTS.length * 48 + 2);
    expect(Math.round((await box("#line")).y - (card.y + card.h))).toBe(12);
    const foot = await box("#agents .foot");
    expect(Math.round((await box("#open")).y - foot.y)).toBe(56);
    expect((await box("#open")).h).toBe(40);
    expect(await page!.$eval("#line", el => getComputedStyle(el).fontSize)).toBe("13px");
    expect(await page!.$eval("#line", el => getComputedStyle(el).color)).toBe(await mutedInk());
    expect(await page!.$eval("#rows .state", el => /mono/i.test(getComputedStyle(el).fontFamily) && getComputedStyle(el).fontSize === "12px")).toBe(true);
    // One loud thing: the keycap.
    expect(await page!.$$eval("#agents .primary", els => els.length)).toBe(1);
    expect(await page!.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    expect((await page!.textContent("#status"))?.trim()).toBe("");
    await page!.screenshot({ path: join(SHOTS, `onboarding-agents-${theme}.png`) });
  });

  it("holds Open wsp while no agent is ticked and says why, and a tick frees it; the press installs into the ticked ones and opens wsp", async () => {
    await agents("light");
    await page!.click("#rows .row:nth-child(1)");
    expect(await page!.isEnabled("#open")).toBe(true);
    await page!.click("#rows .row:nth-child(2)");
    expect(await page!.isDisabled("#open")).toBe(true);
    expect(await page!.textContent("#line")).toBe(LINES.noneTicked);
    // A missing agent's row cannot be ticked.
    await page!.click("#rows .row:nth-child(3)", { force: true });
    expect(await page!.isDisabled("#open")).toBe(true);
    await page!.click("#rows .row:nth-child(2)");
    expect(await page!.isEnabled("#open")).toBe(true);
    expect(await page!.textContent("#line")).toBe(LINES.some);
    await page!.click("#open");
    await page!.waitForFunction(() => (window as unknown as { __opened?: boolean }).__opened === true);
    expect(await page!.evaluate(() => (window as unknown as { __installed?: string[] }).__installed)).toEqual(["codex"]);
  });

  it.each(["dark", "light"] as const)("in the %s appearance a computer with no agents holds every row, says what to install, and the keycap reads Check again", async theme => {
    await agents(theme, "reduce", NO_AGENTS);
    expect((await rows()).map(r => [r.checked, r.disabled, r.state])).toEqual(AGENTS.map(() => [false, true, "not installed"]));
    expect(await page!.textContent("#line")).toBe(LINES.noneFound);
    expect(await keycap()).toBe("Check again");
    expect(await page!.isEnabled("#open")).toBe(true);
    await page!.screenshot({ path: join(SHOTS, `onboarding-agents-none-${theme}.png`) });
  });

  it("Check again reads the agents again, and the screen becomes the one with them found", async () => {
    await agents("light", "reduce", FOUND_ON_SECOND_READ);
    expect(await keycap()).toBe("Check again");
    await page!.click("#open");
    await page!.waitForFunction(() => (document.querySelector("#open")?.textContent ?? "").includes("Open wsp"));
    expect((await rows()).filter(r => r.checked).map(r => r.name)).toEqual(["Claude Code", "Codex"]);
    expect(await page!.textContent("#line")).toBe(LINES.some);
    // It only read again: nothing was installed and wsp did not open.
    expect(await page!.evaluate(() => (window as unknown as { __opened?: boolean }).__opened)).toBeUndefined();
  });

  it("a read of the agents that fails says so in the refusal slot, with the shell's words on its title, and offers Check again", async () => {
    await agents("light", "reduce", UNREAD);
    expect(await page!.$$eval("#rows .row", els => els.length)).toBe(0);
    expect(await page!.textContent("#status")).toBe("The agents on this Mac could not be read. Press Check again to read them again.");
    expect(await page!.getAttribute("#status", "title")).toContain("EACCES");
    expect(await page!.getAttribute("#status", "title")).not.toContain("Error invoking");
    expect(await keycap()).toBe("Check again");
    expect(await page!.textContent("#line")).toBe("");
  });

  it.each(["dark", "light"] as const)("in the %s appearance a config that refused the tools is said in the footer's gap as two halves, the destructive ink then the foreground ink, over two lines that move nothing", async theme => {
    await agents(theme, "reduce", TOOLS_REFUSED);
    const before = { head: await box("#agents .head"), card: await box("#rows"), keycap: await box("#open") };
    await page!.click("#open");
    await page!.waitForFunction(() => (document.querySelector("#status")?.textContent ?? "") !== "");
    const foot = await box("#agents .foot");
    const slot = await box("#status");
    expect(Math.round(slot.y - foot.y)).toBe(18);
    expect(slot.w).toBe(560);
    expect(slot.h).toBeGreaterThanOrEqual(36);
    expect({ head: await box("#agents .head"), card: await box("#rows"), keycap: await box("#open") }).toEqual(before);
    const drawn = await page!.$eval("#status", el => {
      const fix = el.querySelector(".fix")!;
      const style = getComputedStyle(el);
      return {
        happened: (el.textContent ?? "").replace(fix.textContent ?? "", "").trim(),
        fix: fix.textContent,
        ink: style.color,
        fixInk: getComputedStyle(fix).color,
        font: `${style.fontSize}/${style.lineHeight}`,
        mono: /mono/i.test(style.fontFamily),
        title: el.getAttribute("title"),
      };
    });
    expect(drawn.happened).toBe("Claude Code and Codex would not take the wsp tools.");
    expect(drawn.fix).toBe(TOOLS_FIX);
    expect(drawn.font).toBe("12px/18px");
    expect(drawn.mono).toBe(true);
    expect(drawn.title).toContain("EACCES");
    const inks = await tokenInks();
    expect(drawn.ink).toBe(inks.destructive);
    expect(drawn.fixInk).toBe(inks.foreground);
    expect(drawn.ink).not.toBe(inks.muted);
    expect(await page!.isEnabled("#open")).toBe(true);
    expect(await page!.$eval("#status", el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
    expect(await page!.evaluate(() => (window as unknown as { __opened?: boolean }).__opened)).toBeUndefined();
    await page!.screenshot({ path: join(SHOTS, `onboarding-agents-refused-${theme}.png`) });
  });

  it("keeps every refusal inside the two lines the slot stands at, however many configs refused at once", async () => {
    await agents("light", "reduce", SIX_REFUSED);
    const key = await box("#open");
    await page!.click("#open");
    await page!.waitForFunction(() => (document.querySelector("#status")?.textContent ?? "") !== "");
    const slot = await box("#status");
    expect(slot.h).toBe(36);
    expect(key.y - (slot.y + slot.h)).toBeGreaterThan(0);
    expect(await box("#open")).toEqual(key);
    expect(await page!.textContent("#status")).toBe(`Claude Code, Codex and 4 more would not take the wsp tools. ${TOOLS_FIX}`);
    for (const id of ["claude", "codex", "gemini", "opencode", "pi", "hermes"]) expect(await page!.getAttribute("#status", "title")).toContain(`${id}: `);
    await page!.screenshot({ path: join(SHOTS, "onboarding-agents-refused-six-light.png") });
  });

  it("holds the line under the card at one row of height before a slow scan answers, then fills the card and the line", async () => {
    await open("light", "reduce", SLOW_SCAN, WINDOW, false);
    await page!.click("#start");
    expect(await page!.$$eval("#rows .row", els => els.length)).toBe(0);
    expect(await page!.textContent("#line")).toBe("");
    expect((await box("#line")).h).toBeCloseTo(19.5, 1);
    await page!.waitForFunction(() => (document.querySelector("#line")?.textContent ?? "") !== "", undefined, { timeout: 10_000 });
    expect(await page!.$$eval("#rows .row", els => els.length)).toBe(AGENTS.length);
    expect(await page!.textContent("#line")).toBe(LINES.some);
  });

  it.each(["dark", "light"] as const)("in the %s appearance the welcome's entrance is CSS alone: at 0 ms nothing is drawn, mid-way the tilde is drawing and its edge unlit, at rest everything stands", async theme => {
    await open(theme);
    await seek(FRAMES["0ms"]);
    expect(await dashOffset("#welcome .tilde .body")).toBeGreaterThan(20);
    expect(await floodOpacity("#welcome .tilde .lit")).toBe(0);
    expect(await opacity("#welcome .foot")).toBe(0);
    await page!.screenshot({ path: join(SHOTS, `onboarding-welcome-${theme}-0ms.png`) });
    await seek(FRAMES["500ms"]);
    const drawn = await dashOffset("#welcome .tilde .body");
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(20);
    expect(await floodOpacity("#welcome .tilde .lit")).toBe(0);
    expect(await opacity("#welcome .foot")).toBe(0);
    await page!.screenshot({ path: join(SHOTS, `onboarding-welcome-${theme}-500ms.png`) });
    // The stroke, its top edge, the keycap and the halo behind the mark are all of it; each plays once, holds its
    // start before its delay, and the whole ends inside 1.5 s. The hidden agents screen plays nothing yet.
    const timing = await page!.evaluate(() =>
      document.getAnimations().map(a => {
        const effect = a.effect as KeyframeEffect;
        const t = effect.getComputedTiming();
        const target = effect.target as Element;
        return { target: `${target.getAttribute("class") ?? ""}${effect.pseudoElement ?? ""}`, end: (t.delay ?? 0) + Number(t.duration), fill: t.fill, iterations: t.iterations };
      }),
    );
    expect(timing.map(t => t.target).sort()).toEqual(["body", "foot", "hero::before", "lit"]);
    for (const t of timing) {
      expect(t.end).toBeLessThanOrEqual(1500);
      expect(t.fill).toBe("backwards");
      expect(t.iterations).toBe(1);
    }
    await settle();
    expect(await dashOffset("#welcome .tilde .body")).toBe(0);
    expect(await floodOpacity("#welcome .tilde .lit")).toBe(1);
    expect(await opacity("#welcome .foot")).toBe(1);
    expect(await focusRing("#start")).toEqual({ visible: false, outline: "none" });
  });

  it("brings the agents screen in as one piece: its head, card and footer rise within half a second", async () => {
    await open("dark");
    await settle();
    await page!.click("#start");
    const timing = await page!.evaluate(() =>
      document
        .getAnimations()
        .filter(a => ((a.effect as KeyframeEffect).target as Element).closest("#agents") !== null)
        .map(a => {
          const t = a.effect!.getComputedTiming();
          return { target: ((a.effect as KeyframeEffect).target as Element).getAttribute("class") ?? "", end: (t.delay ?? 0) + Number(t.duration) };
        }),
    );
    expect(timing.map(t => t.target).sort()).toEqual(["content", "foot", "head"]);
    for (const t of timing) expect(t.end).toBeLessThanOrEqual(500);
    await settle();
    for (const s of ["#agents .head", "#agents .content", "#agents .foot"]) expect(await opacity(s)).toBe(1);
  });

  it("with reduced motion the final frame is there at 0 ms", async () => {
    await open("dark", "reduce");
    await seek(0);
    expect(await page!.evaluate(() => document.getAnimations().length)).toBe(0);
    expect(await dashOffset("#welcome .tilde .body")).toBe(0);
    expect(await floodOpacity("#welcome .tilde .lit")).toBe(1);
    expect(await opacity("#welcome .foot")).toBe(1);
  });

  it("Enter moves the welcome on and then opens wsp, and puts no ring anywhere: a ring comes only where the keyboard puts the focus", async () => {
    await open("dark");
    await settle();
    expect(await page!.$$eval(":focus-visible", els => els.length)).toBe(0);
    await page!.keyboard.press("Enter");
    expect(await visible("#agents")).toBe(true);
    await settle();
    expect(await page!.$$eval(":focus-visible", els => els.length)).toBe(0);
    await page!.keyboard.press("Enter");
    await page!.waitForFunction(() => (window as unknown as { __opened?: boolean }).__opened === true);
    await page!.keyboard.press("Tab");
    expect((await focusRing(":focus-visible")).outline).toBe("solid");
  });

  it.each(["dark", "light"] as const)("photographs the %s side at the size the mocks were drawn at, so a judge lays the shot beside the mock", async theme => {
    const tail = theme === "dark" ? "-dark" : "";
    await open(theme, "reduce", bridge(), JUDGE);
    await page!.screenshot({ path: join(SHOTS, `02a-welcome-1440${tail}.png`) });
    await page!.click("#start");
    await page!.screenshot({ path: join(SHOTS, `02b-agents-1440${tail}.png`) });
    await page!.close();
    await agents(theme, "reduce", NO_AGENTS, JUDGE);
    await page!.screenshot({ path: join(SHOTS, `02b2-agents-none-1440${tail}.png`) });
  });
});
