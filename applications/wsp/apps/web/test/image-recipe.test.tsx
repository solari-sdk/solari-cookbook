// SPDX-License-Identifier: AGPL-3.0-only
// Choosing what goes on the image inside the Image card: the init job's road,
// read and screens drawn in place with their drafts and disk tally, Build
// sending init.build with this computer as the place and no first workspace,
// what the image holds on every computer's card with Edit beside it, and every
// press that would start a build held while one runs.
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUD_SETUP_WORDS, DEFAULT_PREFERENCES, copyStoppedLine, initDiskOverLine, type InitJob, type InitScreen, type InitSetup, type PlaceView, type SealedImage, type SealedImageView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { copyCost, IMAGE_WORDS } from "../src/settings/image.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const AGENTS: InitScreen = { id: "agents", title: "Agents", top: "Which agents go on the image", items: [{ id: "claude", label: "Claude Code", size: 208 * MIB, detail: [] }, { id: "codex", label: "Codex", size: 455 * MIB, detail: [] }], ticks: ["claude"], answers: {}, footer: [], tally: "agents" };
const TOOLS: InitScreen = { id: "tools", title: "Tools", top: "Tools from your usage", items: [{ id: "gh", label: "gh", size: 12 * MIB, detail: [] }, { id: "swift", label: "Swift 6.3", size: 30 * GIB, detail: [] }], ticks: ["gh"], answers: {}, footer: [], tally: "tools" };
const LOGINS: InitScreen = { id: "logins", title: "Sign-ins", top: "How sign-ins reach the machine", items: [{ id: "logins/claude", label: "Claude Code login", mark: "claude", detail: [], choices: [{ value: "machine", label: "sign in on the machine" }, { value: "key", label: "API key" }], key: { name: "ANTHROPIC_API_KEY", saved: false } }], ticks: [], answers: { "logins/claude": "machine" }, footer: [] };
const WSP: InitScreen = { id: "wsp", title: "wsp for your agents", top: "Add wsp's tools", items: [{ id: "wsp-tools/claude", label: "Claude Code", detail: [] }], ticks: [], answers: {}, footer: [] };
const JOB: InitJob = { id: "init_1", road: "manual", phase: "answering", keys: {}, step: 0, stoppable: true, disk: { fixed: 2 * GIB, total: 20 * GIB }, screens: [AGENTS, TOOLS, LOGINS, WSP], rows: [], progress: { done: 0, total: 0 }, log: [] };
const SETUP: InitSetup = { keys: {}, home: "/Users/dev", agents: [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, place: { id: "p_2", name: "hetzner" }, job: null };

const HASH = "a".repeat(64);
const USED = { kind: "used" as const, sessions: 12, calls: 40 };
const IMAGE: SealedImage = {
  name: "default",
  version: 3,
  hash: HASH,
  recipeHash: "recipe-1",
  recipe: { version: 1, at: "2026-09-12T09:00:00.000Z", histories: [], rows: [{ id: "claude", kind: "agent", on: true, source: USED }, { id: "codex", kind: "agent", on: false, source: USED }, { id: "gh", kind: "tool", on: true, source: USED }], custom: [{ kind: "custom", id: "c1", name: "protoc", install: ["apt-get install -y protobuf-compiler"], check: "command -v protoc", why: "added by the agent" }] },
  logins: [{ name: "claude", state: "copied" }],
  sealedAt: "2026-09-12T09:12:00.000Z",
  sealedFrom: "this Mac",
  place: "p_2",
  vault: { sha256: "c".repeat(64), bytes: 4_200, paths: 7, takenAt: "2026-09-12T11:00:00.000Z" },
};
const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", buildsImages: false };
const box: PlaceView = { id: "p_2", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true, engine: "docker", buildsImages: true };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true, buildsImages: true };

type Call = { op: string; o?: unknown };

/** A host that holds the one init job and moves it as the setup's own host does, every change landing in the store. */
function host(view: SealedImageView, o: { setup?: InitSetup; job?: InitJob | null; answerGate?: Promise<void> } = {}) {
  const calls: Call[] = [];
  let job: InitJob | null = o.job ?? null;
  const put = (next: InitJob): InitJob => {
    job = next;
    act(() => useStore.setState({ initJob: next }));
    return next;
  };
  const fake = settingsApi({
    image: async () => view,
    initGet: async (a?: { on?: string }) => {
      calls.push({ op: "get", o: a });
      return { ...(o.setup ?? SETUP), job };
    },
    initStart: async (a: unknown) => {
      calls.push({ op: "start", o: a });
      return put({ ...JOB, phase: "reading", screens: [] });
    },
    initAnswer: async (a: { screen: string; ticks?: string[]; answers?: Record<string, string> }) => {
      calls.push({ op: "answer", o: a });
      if (o.answerGate !== undefined) await o.answerGate;
      const current = job ?? JOB;
      return put({ ...current, step: Math.min(current.screens.findIndex(s => s.id === a.screen) + 1, current.screens.length), drafts: (current.drafts ?? []).filter(d => d.at !== a.screen) });
    },
    initStep: async (a: { at: number }) => {
      calls.push({ op: "step", o: a });
      return put({ ...(job ?? JOB), step: a.at });
    },
    initDraft: async (a: { at: string; ticks?: string[]; answers?: Record<string, string> }) => {
      calls.push({ op: "draft", o: a });
      const current = job ?? JOB;
      return put({ ...current, drafts: [...(current.drafts ?? []).filter(d => d.at !== a.at), { at: a.at, ticks: a.ticks ?? [], answers: a.answers ?? {} }] });
    },
    initKeys: async (a: unknown) => {
      calls.push({ op: "keys", o: a });
      return { ...SETUP, job };
    },
    initBuild: async (a: unknown) => {
      calls.push({ op: "build", o: a });
      return put({ ...(job ?? JOB), phase: "building", place: { id: "p_2", name: "hetzner" }, progress: { done: 0, total: 9 } });
    },
    imageBuild: async () => new Promise<never>(() => {}),
    initCancel: async () => {
      calls.push({ op: "cancel" });
      return put({ ...(job ?? JOB), phase: "cancelled" });
    },
  } as Partial<Api>);
  return { ...fake, calls, put, ops: () => calls.map(c => c.op) };
}

const card = (): HTMLElement => document.querySelector<HTMLElement>("[data-settings-page] [data-settings-card='image']")!;
const k = (key: string): HTMLElement | null => card().querySelector<HTMLElement>(`[data-k='${key}']`);
const recipeStep = (): string | null => k("recipe")?.getAttribute("data-step") ?? null;
const statePress = (): HTMLButtonElement | null => card().querySelector<HTMLButtonElement>("[data-k='image-state'] [data-k='image-press']");

const open = async (api: Api, id: string): Promise<void> => {
  mountSettings({ api, at: { kind: "computer", id } });
  await settle();
};
const press = async (key: string): Promise<void> => {
  fireEvent.click(k(key)!);
  await settle();
};

beforeEach(() => {
  resetSettings();
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false }, places: [here, box, solari], initJob: null, goldenFrames: {} });
});
afterEach(() => cleanup());

describe("the recipe in the Image card", () => {
  it("walks the road, the read and the host's screens in place, counting the shown screens only, and Build sends init.build with this computer and no first workspace", async () => {
    const fake = host({ image: null, copies: [], projects: [] });
    await open(fake.api, "p_2");
    fireEvent.click(statePress()!);
    await settle();
    expect(recipeStep()).toBe("choice");
    expect(fake.calls.find(c => c.op === "get" && (c.o as { on?: string } | undefined)?.on === "p_2")).toBeDefined();
    // The state row gives way while the recipe is open: what to do now is on screen already.
    expect(card().querySelector("[data-k='image-state']")).toBeNull();
    await press("recipe-primary");
    // The job is this computer's from its start, so what it meets before a build is said on this card.
    expect(fake.calls.find(c => c.op === "start")?.o).toEqual({ road: "manual", on: "p_2" });
    expect(recipeStep()).toBe("reading");
    fake.put(JOB);
    await settle();
    expect(recipeStep()).toBe("screen-agents");
    // The wsp screen the first launch answered is left out, and no first workspace's question is counted.
    expect(k("recipe-counter")?.textContent).toBe("1/3");
    expect(k("recipe-primary")?.textContent).toBe(CLOUD_SETUP_WORDS.screen.keycap);
    await press("recipe-primary");
    await press("recipe-primary");
    expect(recipeStep()).toBe("screen-logins");
    // The last screen builds, with what a build takes beside it.
    expect(k("recipe-primary")?.textContent).toBe(IMAGE_WORDS.build);
    expect([...k("recipe-cost")!.querySelectorAll("span")].map(s => s.textContent)).toEqual(copyCost(0.11));
    await press("recipe-primary");
    expect(fake.calls.filter(c => c.op === "answer").map(c => (c.o as { screen: string }).screen)).toEqual(["agents", "tools", "logins", "wsp"]);
    expect(fake.calls.find(c => c.op === "answer" && (c.o as { screen: string }).screen === "wsp")?.o).toEqual({ screen: "wsp", ticks: ["wsp-tools/claude"] });
    expect(fake.calls.find(c => c.op === "build")?.o).toEqual({ on: "p_2" });
    // The build closes the recipe and stands under the card in the state row's place.
    expect(k("recipe")).toBeNull();
    expect(k("build")?.getAttribute("data-step")).toBe("building");
    expect(card().querySelector("[data-k='image-state']")).toBeNull();
  });

  it("keeps each tick on the host as it happens and never drafts a typed key, which goes to the key store on Continue", async () => {
    const fake = host({ image: null, copies: [], projects: [] }, { job: JOB });
    useStore.setState({ initJob: JOB });
    await open(fake.api, "p_2");
    // A recipe being chosen stands open on the card, on the step the host holds.
    expect(recipeStep()).toBe("screen-agents");
    fireEvent.click(card().querySelector("[data-row='codex'] [role='checkbox']")!);
    await settle();
    expect(fake.calls.find(c => c.op === "draft")?.o).toEqual({ at: "agents", ticks: ["claude", "codex"], answers: {} });
    fake.put({ ...JOB, step: 2 });
    await settle();
    expect(recipeStep()).toBe("screen-logins");
    fireEvent.click(card().querySelector("[data-k='answer'][data-row='logins/claude']")!);
    await settle();
    fireEvent.click(document.querySelector("[data-k='option'][data-value='key']")!);
    await settle();
    const drafts = fake.calls.filter(c => c.op === "draft").length;
    fireEvent.change(card().querySelector<HTMLInputElement>("[data-k='key-field'] input")!, { target: { value: "sk-ant-x" } });
    await settle();
    expect(fake.calls.filter(c => c.op === "draft").length).toBe(drafts);
    expect(JSON.stringify(fake.calls.filter(c => c.op === "draft"))).not.toContain("sk-ant-x");
    await press("recipe-primary");
    expect(fake.calls.find(c => c.op === "keys")?.o).toEqual({ rows: { "logins/claude": "sk-ant-x" } });
    expect(JSON.stringify(fake.calls.find(c => c.op === "answer")?.o)).not.toContain("sk-ant-x");
  });

  it("refuses Continue over the disk with the overshoot and sends nothing", async () => {
    const heavy: InitJob = { ...JOB, step: 1, screens: [AGENTS, { ...TOOLS, ticks: ["gh", "swift"] }, LOGINS, WSP] };
    const fake = host({ image: null, copies: [], projects: [] }, { job: heavy });
    useStore.setState({ initJob: heavy });
    await open(fake.api, "p_2");
    expect(recipeStep()).toBe("screen-tools");
    await press("recipe-primary");
    expect(k("recipe-refusal")?.textContent).toMatch(/^.+/);
    expect(k("recipe-refusal")?.textContent).toBe(initDiskOverLine(2 * GIB + 208 * MIB + 12 * MIB + 30 * GIB - 20 * GIB));
    expect(fake.ops()).not.toContain("answer");
  });

  it("says what the image holds on every computer's card, and Edit opens the recipe there, whose Build names the image's own place when that is another computer", async () => {
    const fake = host({ image: IMAGE, copies: [], projects: [] }, { setup: { ...SETUP, keys: { solari: true } } });
    await open(fake.api, "solari");
    const holds = card().querySelector("[data-k='image-holds']")!;
    expect(holds.querySelector("[data-settings-title]")?.textContent).toBe(IMAGE_WORDS.holds);
    expect(holds.querySelector("[data-settings-description]")?.textContent).toBe("Claude Code, GitHub CLI, protoc");
    await press("edit-recipe");
    expect(recipeStep()).toBe("choice");
    await press("recipe-primary");
    fake.put({ ...JOB, step: 2 });
    await settle();
    expect(k("recipe-note")?.textContent).toBe(IMAGE_WORDS.buildsHome("hetzner", 4));
    await press("recipe-primary");
    expect(fake.calls.find(c => c.op === "build")?.o).toEqual({ on: "solari" });
  });

  it("holds Build and Edit with where the image is building while a build runs on another computer", async () => {
    const running: InitJob = { ...JOB, phase: "building", place: { id: "solari", name: "solari" }, progress: { done: 1, total: 9 } };
    useStore.setState({ initJob: running });
    await open(host({ image: IMAGE, copies: [], projects: [] }, { job: running }).api, "p_2");
    expect(k("edit-recipe")?.hasAttribute("data-held")).toBe(true);
    expect(k("image-refusal")?.textContent).toBe(IMAGE_WORDS.buildingOn("Solari"));
    cleanup();
    resetSettings();
    useStore.setState({ places: [here, box, solari], initJob: running, goldenFrames: {} });
    await open(host({ image: null, copies: [], projects: [] }, { job: running }).api, "p_2");
    expect(statePress()?.hasAttribute("data-held")).toBe(true);
    expect(k("image-refusal")?.textContent).toBe(IMAGE_WORDS.buildingOn("Solari"));
  });

  it("Close leaves the job where it is, Start over ends it and goes back to the road, and an ended agent step goes back without ending anything", async () => {
    const fake = host({ image: null, copies: [], projects: [] }, { job: JOB });
    useStore.setState({ initJob: JOB });
    await open(fake.api, "p_2");
    await press("recipe-close");
    expect(k("recipe")).toBeNull();
    expect(fake.ops()).not.toContain("cancel");
    fireEvent.click(statePress()!);
    await settle();
    expect(recipeStep()).toBe("screen-agents");
    await press("recipe-again");
    expect(fake.ops()).toContain("cancel");
    expect(recipeStep()).toBe("choice");
    const stopped: InitJob = { ...JOB, id: "init_2", road: "agent", phase: "failed", screens: [], error: "the thread ended before the recipe was written", thread: { id: "th_1", workspaceId: "ws_local", session: "t1", harness: "claude" } };
    fake.put(stopped);
    await settle();
    expect(recipeStep()).toBe("agent");
    expect(k("recipe-title")?.textContent).toBe(CLOUD_SETUP_WORDS.agent.failed);
    const cancels = fake.ops().filter(op => op === "cancel").length;
    await press("recipe-again");
    expect(recipeStep()).toBe("choice");
    expect(fake.ops().filter(op => op === "cancel").length).toBe(cancels);
  });

  it("opens the recipe from a first build that stopped here, the build saying why in the state row's place: Start over under the build, or Build once the build is closed", async () => {
    const failed: InitJob = { ...JOB, phase: "failed", place: { id: "p_2", name: "hetzner" }, error: copyStoppedLine("no room on hetzner") };
    useStore.setState({ initJob: failed });
    await open(host({ image: null, copies: [], projects: [] }, { job: failed }).api, "p_2");
    expect(card().querySelector("[data-k='image-state']")).toBeNull();
    expect(k("build-sentence")?.textContent).toBe(copyStoppedLine("no room on hetzner"));
    await press("build-primary");
    expect(recipeStep()).toBe("choice");
    await press("recipe-close");
    await press("build-close");
    // Closed, the state row comes back with the state the build left.
    expect(card().querySelector("[data-k='image-state']")?.getAttribute("data-state")).toBe("stopped");
    expect(card().querySelector("[data-k='image-state'] [data-settings-description]")?.textContent).toBe(copyStoppedLine("no room on hetzner"));
    expect(statePress()?.textContent).toBe(IMAGE_WORDS.buildHere);
    fireEvent.click(statePress()!);
    await settle();
    expect(recipeStep()).toBe("choice");
  });

  it("holds Build while its press is on its way, so a second press sends no second build", async () => {
    let letGo: () => void = () => {};
    const gate = new Promise<void>(r => (letGo = r));
    const last: InitJob = { ...JOB, step: 2 };
    const fake = host({ image: null, copies: [], projects: [] }, { job: last, answerGate: gate });
    useStore.setState({ initJob: last });
    await open(fake.api, "p_2");
    expect(recipeStep()).toBe("screen-logins");
    fireEvent.click(k("recipe-primary")!);
    await settle();
    expect(k("recipe-primary")?.hasAttribute("disabled")).toBe(true);
    fireEvent.click(k("recipe-primary")!);
    fireEvent.click(k("recipe-back")!);
    await settle();
    await act(async () => letGo());
    await settle();
    expect(fake.ops().filter(op => op === "build")).toHaveLength(1);
    expect(fake.ops().filter(op => op === "answer")).toHaveLength(2);
    expect(fake.ops()).not.toContain("step");
  });
});
