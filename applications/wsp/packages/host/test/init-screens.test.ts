// SPDX-License-Identifier: AGPL-3.0-only
// The screens as data: the same rows the terminal's list draws, built
// by the same functions, handed to the app to draw. A tick answered on one
// screen moves the recipe the way the terminal's screen moves it. Where the
// app's words differ from the terminal's they are set here and tested here.
import { describe, expect, it } from "vitest";
import { CATALOG_TOOLS } from "@wsp/catalog";
import { BUILDER_DISK_GB, DISK_ROOM_BYTES } from "@wsp/engine";
import { CLOUD_SETUP_WORDS, InitScreen, type Recipe } from "@wsp/protocol";
import { ALWAYS_GROUP, USAGE_GROUP, answerScreen, diskOf, keyNameFor, screensOf, type ScreenAnswers } from "../src/init-screens.js";
import { AGENTS_TITLE, AGENTS_TOP, SIGN_INS_TITLE, SIGN_INS_TOP, TOOLS_TITLE, TOOLS_TOP, WSP_TOP, wspTitle } from "../src/init-pick.js";
import { alsoTitle, alsoTop } from "../src/init-also.js";
import type { Reading } from "../src/init.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";

const HOME = "/Users/dev";
const MIB = 1024 * 1024;
const reading = (over: Partial<Reading> = {}): Reading => ({ manifest: FIXTURE, platform: "darwin", catalogRecipe: RECIPE, savedPins: new Map(), brew: new Map(), scanned: [], notes: [], source: "found on this computer", ...over });
const fresh = (recipe: Recipe = RECIPE): ScreenAnswers => ({ recipe, logins: new Map(), wspTicks: undefined });
/** One formula a manager here could put on the image, so the Also screen has a row and is shown. */
const SCANNED = { id: "brew/jq", name: "jq", manager: "brew", group: "Homebrew formulae", install: "brew install jq", check: "command -v jq", size: 2 * MIB } as const;
const at = (saved: Record<string, string> = {}) => ({ statePath: "/tmp/state.json", home: HOME, saved: () => saved });

describe("the screens as data", () => {
  it("the screens in the terminal's order, each parsing as the wire's shape, no title or sentence ending in a period; one with no row to pick is not among them", () => {
    const screens = screensOf(reading({ scanned: [SCANNED] }), fresh(), at());
    expect(screens.map(s => [s.id, s.title])).toEqual([
      ["agents", AGENTS_TITLE],
      ["tools", TOOLS_TITLE],
      ["also", alsoTitle("darwin")],
      ["logins", SIGN_INS_TITLE],
      ["wsp", wspTitle("darwin")],
    ]);
    for (const s of screens) expect(InitScreen.parse(s)).toEqual(s);
    for (const top of [AGENTS_TOP, TOOLS_TOP, alsoTop("darwin"), SIGN_INS_TOP, WSP_TOP]) expect(top).not.toMatch(/\.$/);
    expect(SIGN_INS_TOP).toBe("How sign-ins reach the machine");
    // No formula found here: the Also screen is not shown, and the screens after it move up.
    expect(screensOf(reading(), fresh(), at()).map(s => s.id)).toEqual(["agents", "tools", "logins", "wsp"]);
    // Nothing read off this computer and no agent ticked, so no sign-in row either: three screens for the app to
    // count, since the app leaves the wsp screen to the first launch.
    const agentsOff: Recipe = { ...RECIPE, rows: RECIPE.rows.map(r => (r.kind === "agent" ? { ...r, on: false } : r)) };
    expect(screensOf(reading({ manifest: { entries: [] } }), fresh(agentsOff), at()).map(s => s.id)).toEqual(["agents", "tools", "wsp"]);
    // And no agent here that takes the wsp tools: that screen is not shown either.
    const noAgentHere: Recipe = { ...agentsOff, rows: agentsOff.rows.map(r => (r.source.kind === "installed" ? { ...r, source: { kind: "popular", sessions: 0, images: 0 } } : r)) };
    expect(screensOf(reading({ manifest: { entries: [] } }), fresh(noAgentHere), at()).map(s => s.id)).toEqual(["agents", "tools"]);
  });

  it("the agents screen ticks what the recipe ticks, sizes each row in bytes, says why in one sentence, and names the tally's noun with no footer line", () => {
    const [agents] = screensOf(reading(), fresh(), at());
    expect(agents!.items.map(i => i.id)).toContain("claude");
    expect(agents!.items.map(i => i.id)).toContain("codex");
    expect(agents!.ticks).toEqual(["claude"]);
    const claude = agents!.items.find(i => i.id === "claude")!;
    expect(claude.size).toBe(208 * MIB);
    expect(claude).not.toHaveProperty("hint");
    expect(claude.why).toBe("installed here, never used");
    expect(claude.detail[0]).toContain("on this Mac");
    expect(agents!.footer).toEqual([]);
    expect(agents!.tally).toBe("agents");
    // The what-else screen counts too, in a word that does not take a plural: "3 more on the image".
    const also = screensOf(reading({ scanned: [SCANNED] }), fresh(), at()).find(s => s.id === "also")!;
    expect(also.tally).toBe("more");
  });

  it("the tools screen is two groups, the base checked and locked under one divider in the catalog's order with no calls however used, and the rest by calls, each usage row one number, no footer lines", () => {
    const used = (id: string, calls: number, sessions = 3): Recipe["rows"][number] => ({ id, kind: "tool", on: true, source: { kind: "used", sessions, calls } });
    const floor = CATALOG_TOOLS.filter(e => e.floor).map(e => e.id);
    // A base tool the agents ran here more than anything: it stays where the catalog puts it and carries no number.
    const heavyBase = floor[0]!;
    const recipe: Recipe = { ...RECIPE, rows: [...RECIPE.rows.filter(r => r.id !== "gh" && r.id !== "yq" && r.id !== heavyBase), used("gh", 412), used("yq", 29_623), used(heavyBase, 99_999)] };
    const tools = screensOf(reading(), fresh(recipe), at())[1]!;
    const base = tools.items.filter(i => i.group === ALWAYS_GROUP);
    expect(base.map(i => i.id)).toEqual(floor);
    expect(base.every(i => i.lock === "on" && i.why === undefined)).toBe(true);
    expect(tools.items.filter(i => i.group !== ALWAYS_GROUP).every(i => i.group === USAGE_GROUP)).toBe(true);
    // Most calls first within the usage group, whatever the tick; a row never used carries no number.
    const usage = tools.items.filter(i => i.group === USAGE_GROUP);
    expect(usage.slice(0, 2).map(i => [i.id, i.why])).toEqual([
      ["yq", "29,623 calls"],
      ["gh", "412 calls"],
    ]);
    expect(usage.slice(2).every(i => i.why === undefined)).toBe(true);
    expect(tools.items.every(i => i.size === null || typeof i.size === "number")).toBe(true);
    expect(tools.footer).toEqual([]);
    expect(tools.tally).toBe("tools");
    // The row's own words: the label and the number. The detail behind the row keeps the terminal's sentences.
    expect(JSON.stringify(tools.items.map(i => [i.label, i.why, i.group]))).not.toMatch(/floor|heavy|used|installed|session/);
  });

  it("answering the agents screen moves the recipe as the terminal's screen would, and the disk the ring draws grows with the ticks", () => {
    const answers = answerScreen(reading(), fresh(), "agents", { ticks: ["claude", "codex"] });
    expect(answers.recipe.rows.filter(r => r.kind === "agent" && r.on).map(r => r.id).sort()).toEqual(["claude", "codex"]);
    const before = diskOf(reading(), RECIPE, "/tmp/state.json", BUILDER_DISK_GB)!;
    const after = diskOf(reading(), answers.recipe, "/tmp/state.json", BUILDER_DISK_GB)!;
    expect(before.total).toBe(BUILDER_DISK_GB * 1024 * MIB);
    // A provider that gives a builder no disk figure draws no ring: a container's disk is the box's.
    expect(diskOf(reading(), RECIPE, "/tmp/state.json")).toBeUndefined();
    // The fixed part is the base the room leaves out of the disk plus the files that travel; a ticked agent's config
    // joins the files, and the rows' own sizes are the app's to add from its ticks.
    expect(before.fixed).toBeGreaterThanOrEqual(before.total - DISK_ROOM_BYTES);
    expect(before.fixed - (before.total - DISK_ROOM_BYTES)).toBeLessThan(MIB);
    expect(after.fixed - before.fixed).toBe(8_000);
    // The tools screen keeps the floor rows locked on, as the terminal does.
    const floor = CATALOG_TOOLS.filter(e => e.floor).map(e => e.id);
    expect(screensOf(reading(), answers, at())[1]!.items.filter(i => floor.includes(i.id)).every(i => i.lock === "on")).toBe(true);
  });

  it("names the computer it is reading: a Mac by name on a Mac, the plain word on a Linux laptop, on every title and every row that says where a thing is", () => {
    const words = (platform: "darwin" | "linux") => {
      const screens = screensOf(reading({ platform, scanned: [SCANNED] }), fresh(), at());
      const agents = screens.find(s => s.id === "agents")!;
      const logins = screens.find(s => s.id === "logins")!;
      return {
        titles: screens.map(s => s.title),
        tops: screens.flatMap(s => s.top),
        // The agents screen's first detail line says whether the agent is here, and the sign-ins screen's copy
        // answer says where the files would be copied from.
        agent: agents.items.find(i => i.id === "claude")!.detail[0],
        copy: logins.items.find(i => i.id === "logins/gh")!.choices!.find(c => c.value === "copy")!.label,
      };
    };
    const mac = words("darwin");
    expect(mac.titles).toContain("Also on this Mac");
    expect(mac.titles).toContain("wsp for your agents on this Mac");
    expect(mac.tops).toContain("What else this Mac brings");
    expect(mac.agent).toContain("on this Mac");
    expect(mac.copy).toBe("copy from this Mac");
    const linux = words("linux");
    expect(linux.titles).toContain("Also on this computer");
    expect(linux.titles).toContain("wsp for your agents on this computer");
    expect(linux.tops).toContain("What else this computer brings");
    expect(linux.agent).toContain("on this computer");
    expect(linux.copy).toBe("copy from this computer");
    // Nothing a person reads on a Linux laptop calls their computer a Mac.
    expect(JSON.stringify(screensOf(reading({ platform: "linux", scanned: [SCANNED] }), fresh(), at()))).not.toContain("Mac");
  });

  it("the sign-ins screen carries each row's choices and its starting answer; an answer moves it and nothing else", () => {
    const screens = screensOf(reading(), fresh(), at());
    const logins = screens.find(s => s.id === "logins")!;
    const gh = logins.items.find(i => i.id === "logins/gh")!;
    expect(gh.choices!.map(c => c.value)).toEqual(expect.arrayContaining(["copy", "machine", "skip"]));
    expect(logins.answers["logins/gh"]).toBeDefined();
    const moved = answerScreen(reading(), fresh(), "logins", { answers: { "logins/gh": "machine" } });
    expect(moved.logins.get("logins/gh")).toBe("machine");
    const again = screensOf(reading(), moved, at()).find(s => s.id === "logins")!;
    expect(again.answers["logins/gh"]).toBe("machine");
    expect(answerScreen(reading(), fresh(), "logins", { answers: { "logins/gh": "dance" } }).logins.get("logins/gh")).toBeUndefined();
  });

  it("a sign-in row shows its source as the short file name with the full path behind it, and an agent row the key variable its agent declares with whether the home holds one", () => {
    const logins = screensOf(reading(), fresh(), at()).find(s => s.id === "logins")!;
    const gh = logins.items.find(i => i.id === "logins/gh")!;
    expect(gh.mark).toBe("gh");
    expect(gh.why).toBe("hosts.yml, Keychain");
    expect(gh.detail[0]).toBe("~/.config/gh/hosts.yml, Keychain: gh:github.com");
    expect(gh.key).toBeUndefined();
    const claude = logins.items.find(i => i.id === "logins/claude")!;
    expect(claude.key).toEqual({ name: "ANTHROPIC_API_KEY", saved: false });
    expect(claude.choices!.map(c => c.value)).toContain("key");
    // Every agent on the image with a key road offers it under its own variable, not only Claude.
    const both = answerScreen(reading(), fresh(), "agents", { ticks: ["claude", "codex"] });
    const codex = screensOf(reading(), both, at()).find(s => s.id === "logins")!.items.find(i => i.id === "logins/codex")!;
    expect(codex.key).toEqual({ name: "OPENAI_API_KEY", saved: false });
    expect(codex.why).toBe("auth.json");
    const held = screensOf(reading(), both, at({ ANTHROPIC_API_KEY: "sk-ant-x-fake" })).find(s => s.id === "logins")!;
    expect(held.items.find(i => i.id === "logins/claude")!.key).toEqual({ name: "ANTHROPIC_API_KEY", saved: true });
    expect(held.items.find(i => i.id === "logins/codex")!.key).toEqual({ name: "OPENAI_API_KEY", saved: false });
    expect(JSON.stringify(held)).not.toContain("sk-ant-x-fake");
    expect(keyNameFor(FIXTURE, "logins/claude")).toBe("ANTHROPIC_API_KEY");
    expect(keyNameFor(FIXTURE, "logins/gh")).toBeUndefined();
    expect(keyNameFor(FIXTURE, "agents/claude")).toBeUndefined();
  });

  it("a sign-in whose tool is off the image is a state word with skip fixed, in place of the terminal's sentence", () => {
    const off: Recipe = { ...RECIPE, rows: RECIPE.rows.filter(r => r.id !== "gh") };
    const manifest = { entries: [...FIXTURE.entries, { rung: "logins" as const, id: "logins/kube", label: "kubeconfig", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "skip" as const }] };
    const logins = screensOf(reading({ manifest }), fresh(off), at()).find(s => s.id === "logins")!;
    const kube = logins.items.find(i => i.id === "logins/kube")!;
    expect(kube.state).toBe(CLOUD_SETUP_WORDS.screen.notOnImage);
    expect(kube.why).toBe("config");
    expect(kube.choices!.map(c => c.value)).toEqual(["skip"]);
    expect(logins.answers["logins/kube"]).toBe("skip");
    expect(logins.items.find(i => i.id === "logins/claude")!.state).toBeUndefined();
  });

  it("a sign-in whose tool stops on a question only the person can answer says so as its state word, and its picker never offers the machine", () => {
    const withHermes: Recipe = { ...RECIPE, rows: [...RECIPE.rows, { id: "hermes", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.hermes/config.yaml"], bin: true } }] };
    const manifest = { entries: [...FIXTURE.entries, { rung: "agents" as const, id: "agents/hermes", label: "Hermes Agent", paths: ["~/.hermes"], bytes: 900, default: "bring" as const }, { rung: "logins" as const, id: "logins/hermes", label: "Hermes Agent login", group: "Agent logins", paths: ["~/.hermes/config.yaml"], bytes: 900, default: "skip" as const }] };
    const logins = screensOf(reading({ manifest }), fresh(withHermes), at()).find(s => s.id === "logins")!;
    const hermes = logins.items.find(i => i.id === "logins/hermes")!;
    expect(hermes.state).toBe(CLOUD_SETUP_WORDS.screen.asksYou);
    expect(hermes.choices!.map(c => c.value)).toEqual(["copy", "skip"]);
    expect(logins.answers["logins/hermes"]).toBe("copy");
    // The state word says it once: the row's detail does not carry it a second time.
    expect(hermes.detail).not.toContain(CLOUD_SETUP_WORDS.screen.asksYou);
    // With nothing of it here to copy the picker is fixed on skip, and the word still says which fact stopped the row.
    const bare = { entries: [...FIXTURE.entries, { rung: "agents" as const, id: "agents/hermes", label: "Hermes Agent", paths: ["~/.hermes"], bytes: 900, default: "bring" as const }, { rung: "logins" as const, id: "logins/hermes", label: "Hermes Agent login", group: "Agent logins", paths: [], bytes: 0, default: "skip" as const }] };
    const alone = screensOf(reading({ manifest: bare }), fresh(withHermes), at()).find(s => s.id === "logins")!.items.find(i => i.id === "logins/hermes")!;
    expect(alone.choices!.map(c => c.value)).toEqual(["skip"]);
    expect(alone.state).toBe(CLOUD_SETUP_WORDS.screen.asksYou);
  });

  it("the wsp screen lists the agents here whose config the catalog can write, ticked once answered, and the Also screen carries no footer", () => {
    const screens = screensOf(reading({ scanned: [SCANNED] }), fresh(), at());
    const wsp = screens.find(s => s.id === "wsp")!;
    expect(wsp.items.map(i => i.id)).toEqual(["wsp-tools/claude"]);
    expect(wsp.items[0]!.detail[0]).toMatch(/^writes ~/);
    const ticked = answerScreen(reading(), fresh(), "wsp", { ticks: ["wsp-tools/claude"] });
    expect(ticked.wspTicks).toEqual(new Set(["wsp-tools/claude"]));
    expect(screensOf(reading(), ticked, at()).find(s => s.id === "wsp")!.ticks).toEqual(["wsp-tools/claude"]);
    const also = screens.find(s => s.id === "also")!;
    expect(also.items.map(i => i.id)).toEqual([SCANNED.id]);
    expect(also.footer).toEqual([]);
  });
});
