// SPDX-License-Identifier: AGPL-3.0-only
// The first launch, driven as the shell drives it: the page it ships as,
// parsed and run, with the bridge the preload exposes faked. A welcome with one
// button, then the agents screen, one row per catalog agent. One rule, one
// case. The page is html and script with no build step, so it is loaded here
// rather than imported, and what a press asks the shell for is the whole of
// what this file reads; what the shell does with each ask is its own road,
// proved where recordThisComputer is.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

/** The page as stage.mjs writes it, minus the stylesheet: nothing here reads a computed colour. */
const PAGE = readFileSync(new URL("../src/onboarding.html", import.meta.url), "utf8").replace("__WEB_CSS__", "about:blank").replace("__AGENT_GLYPHS__", JSON.stringify(["claude", "codex"]));

const TOOLS_FIX = "Take the tick off that agent, or fix its config and press again.";

/** One computer's catalog rows as the recipe scan answers with them: two agents here, two the scan did not find. */
const AGENTS = [
  { id: "claude", name: "Claude Code", found: true, configured: false },
  { id: "codex", name: "Codex", found: true, configured: false },
  { id: "gemini", name: "Gemini CLI", found: false, configured: false },
  { id: "hermes", name: "Hermes", found: false, configured: false },
];

/** The catalog's six agents, every one of them here: the most names one refusal can ever have to carry. */
const SIX = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "opencode", name: "OpenCode" },
  { id: "pi", name: "Pi" },
  { id: "hermes", name: "Hermes" },
].map(a => ({ ...a, found: true, configured: false }));

interface Asks {
  install: string[][];
  finish: number;
  scans: number;
}

interface Screen {
  window: JSDOM["window"];
  asks: Asks;
  at: (selector: string) => Element;
  text: (selector: string) => string;
  press: (selector: string) => Promise<void>;
}

/** The refusal slot's two halves: what happened, in the slot's own destructive ink, then what to do in `.fix`. */
function halves(slot: Element): { happened: string; fix: string } {
  const fix = slot.querySelector(".fix");
  return { happened: (slot.textContent ?? "").replace(fix?.textContent ?? "", "").trim(), fix: fix?.textContent ?? "" };
}

/** The page with the shell's answers in place, opened and left until its scan has landed. `refusedScan` makes the
 * scan reject that many times before it answers, which is how a computer whose agents cannot be read is driven. */
async function open(agents: unknown[] = AGENTS, opts: { refusedScan?: number; refusedTools?: string[] } = {}): Promise<Screen> {
  const asks: Asks = { install: [], finish: 0, scans: 0 };
  const dom = new JSDOM(PAGE, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom has no matchMedia; the page reads it once to follow the computer's appearance, which Chromium answers.
      (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener: () => {} });
      (window as unknown as { wsp: unknown }).wsp = {
        agents: () => {
          asks.scans += 1;
          return asks.scans <= (opts.refusedScan ?? 0) ? Promise.reject(new Error("the agent stores could not be read")) : Promise.resolve(agents);
        },
        install: (ids: string[]) => {
          asks.install.push(ids);
          const refused = opts.refusedTools ?? [];
          return Promise.resolve({
            server: { command: "wsp", args: [] },
            installed: ids.filter(id => !refused.includes(id)).map(id => ({ id })),
            failures: refused.map(id => ({ id, error: `~/.${id}.json: EACCES: permission denied` })),
          });
        },
        finish: () => {
          asks.finish += 1;
          return Promise.resolve();
        },
      };
    },
  });
  const window = dom.window;
  const at = (selector: string): Element => {
    const el = window.document.querySelector(selector);
    if (el === null) throw new Error(`no ${selector} on the first-run screen`);
    return el;
  };
  // The scan is asked for as the page opens; a turn of the loop is all it takes to land and draw.
  await new Promise(landed => window.setTimeout(landed, 0));
  const settle = (): Promise<unknown> => new Promise(done => window.setTimeout(done, 0));
  return {
    window,
    asks,
    at,
    text: selector => at(selector).textContent ?? "",
    press: async selector => {
      (at(selector) as HTMLElement).click();
      await settle();
    },
  };
}

/** Each row of the card: the agent's id off its tick, whether it is ticked, whether it can be, and its word. */
const rows = (screen: Screen): Array<{ id: string; checked: boolean; disabled: boolean; state: string }> =>
  [...screen.window.document.querySelectorAll("#rows .row")].map(row => {
    const check = row.querySelector("input") as HTMLInputElement;
    return { id: check.value, checked: check.checked, disabled: check.disabled, state: row.querySelector(".state")?.textContent ?? "" };
  });
const keycap = (screen: Screen): string => screen.text("#open").replace("→", "").trim();

describe("the first launch", () => {
  it("opens on a welcome of the mark and one button, Get started, which brings the agents screen", async () => {
    const screen = await open();
    const doc = screen.window.document;
    expect((screen.at("#welcome") as HTMLElement).hidden).toBe(false);
    expect((screen.at("#agents") as HTMLElement).hidden).toBe(true);
    expect(doc.querySelectorAll("#welcome h1, #welcome p")).toHaveLength(0);
    expect([...doc.querySelectorAll("#welcome button")].map(b => b.id)).toEqual(["start"]);
    expect(screen.text("#start").replace(/\s+/g, " ").trim()).toBe("Get started →");
    await screen.press("#start");
    expect((screen.at("#welcome") as HTMLElement).hidden).toBe(true);
    expect((screen.at("#agents") as HTMLElement).hidden).toBe(false);
    expect(screen.text("#agents h1")).toBe("Your agents drive wsp");
    expect(doc.querySelectorAll("#agents button.primary")).toHaveLength(1);
  });

  it("draws one row per catalog agent, the found ones first and ticked, the missing ones held, and Open wsp gives the ticked ones the tools and then asks the shell to open the app", async () => {
    const screen = await open();
    expect(rows(screen)).toEqual([
      { id: "claude", checked: true, disabled: false, state: "on this Mac" },
      { id: "codex", checked: true, disabled: false, state: "on this Mac" },
      { id: "gemini", checked: false, disabled: true, state: "not installed" },
      { id: "hermes", checked: false, disabled: true, state: "not installed" },
    ]);
    expect(screen.text("#line")).toBe("Agents you install later get the tools from Settings.");
    expect(keycap(screen)).toBe("Open wsp");
    await screen.press("#open");
    // The tools first, then the one ask that records this computer and opens the app on it.
    expect(screen.asks.install).toEqual([["claude", "codex"]]);
    expect(screen.asks.finish).toBe(1);
  });

  it("holds Open wsp while no agent is ticked and says why; a tick frees it and only the ticked ids ride", async () => {
    const screen = await open();
    for (const id of ["claude", "codex"]) (screen.at(`#rows input[value=${id}]`) as HTMLInputElement).click();
    expect((screen.at("#open") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.text("#line")).toBe("Tick at least one agent. wsp works through the agents you give it.");
    await screen.press("#open");
    expect(screen.asks.install).toEqual([]);
    (screen.at("#rows input[value=codex]") as HTMLInputElement).click();
    expect((screen.at("#open") as HTMLButtonElement).disabled).toBe(false);
    await screen.press("#open");
    expect(screen.asks.install).toEqual([["codex"]]);
  });

  it("on a computer with no agent holds every row and reads Check again, which reads the agents again and opens nothing", async () => {
    const screen = await open(AGENTS.map(a => ({ ...a, found: false })));
    expect(rows(screen).every(r => !r.checked && r.disabled)).toBe(true);
    expect(screen.text("#line")).toBe("No agent found on this Mac. Install Claude Code or Codex, then press Check again.");
    expect(keycap(screen)).toBe("Check again");
    expect((screen.at("#open") as HTMLButtonElement).disabled).toBe(false);
    await screen.press("#open");
    expect(screen.asks.scans).toBe(2);
    expect(screen.asks.install).toEqual([]);
    expect(screen.asks.finish).toBe(0);
  });

  it("draws a refusal as two halves, what happened then what to do, and keeps the keycap live after one", async () => {
    const screen = await open(AGENTS, { refusedTools: ["claude"] });
    expect(screen.text("#status")).toBe("");
    await screen.press("#open");
    expect(screen.asks.finish).toBe(0);
    expect(halves(screen.at("#status"))).toEqual({ happened: "Claude Code's config would not take the wsp tools.", fix: TOOLS_FIX });
    // The shell's own unbounded words are not drawn; they are readable whole on the slot.
    expect(screen.at("#status").getAttribute("title")).toBe("claude: ~/.claude.json: EACCES: permission denied");
    expect((screen.at("#open") as HTMLButtonElement).disabled).toBe(false);
  });

  it("leaves a refused scan's reason standing and never records this Mac off an empty list, reading again on Check again", async () => {
    const screen = await open(AGENTS, { refusedScan: 2 });
    expect(halves(screen.at("#status"))).toEqual({ happened: "The agents on this Mac could not be read.", fix: "Press Check again to read them again." });
    // A scan that learned nothing is not a computer with no agents: no row, and the line says nothing rather than that.
    expect(rows(screen)).toEqual([]);
    expect(screen.text("#line")).toBe("");
    expect(keycap(screen)).toBe("Check again");
    // The press reads again; the second read refuses too, so the reason stands and nothing is recorded.
    await screen.press("#open");
    expect(screen.asks.finish).toBe(0);
    expect(screen.asks.install).toEqual([]);
    expect(halves(screen.at("#status")).happened).toBe("The agents on this Mac could not be read.");
    // The third read lands: the refusal clears and the rows arrive, and the next press opens wsp.
    await screen.press("#open");
    expect(screen.text("#status")).toBe("");
    expect(rows(screen).filter(r => r.checked).map(r => r.id)).toEqual(["claude", "codex"]);
    expect(keycap(screen)).toBe("Open wsp");
    expect(screen.asks.finish).toBe(0);
    await screen.press("#open");
    expect(screen.asks.install).toEqual([["claude", "codex"]]);
    expect(screen.asks.finish).toBe(1);
  });

  it("caps the names a refusal carries, so six refused configs read as two and a count rather than running past two lines", async () => {
    const screen = await open(SIX, { refusedTools: SIX.map(a => a.id) });
    await screen.press("#open");
    const said = halves(screen.at("#status"));
    expect(said).toEqual({ happened: "Claude Code, Codex and 4 more would not take the wsp tools.", fix: TOOLS_FIX });
    // The whole sentence stays inside what two lines of 12 px mono hold at the slot's 560 px, which is about 110 a line.
    expect(`${said.happened} ${said.fix}`.length).toBeLessThanOrEqual(220);
    for (const a of SIX) expect(screen.at("#status").getAttribute("title")).toContain(`${a.id}: `);
    expect(screen.asks.finish).toBe(0);
    const three = await open(SIX, { refusedTools: ["claude", "codex", "gemini"] });
    await three.press("#open");
    expect(halves(three.at("#status")).happened).toBe("Claude Code, Codex and Gemini CLI would not take the wsp tools.");
  });
});
