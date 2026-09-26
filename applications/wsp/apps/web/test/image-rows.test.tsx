// SPDX-License-Identifier: AGPL-3.0-only
// The rows the Image card draws for the recipe and for the image's own build,
// over a fake host: the road as two radios with the harness picker, the read
// of this computer as rows, each screen from the host's data with one
// selection under the ticks, the tally and the disk meter, the sign-ins' picker
// and key field, the step kept on the host, and the build's stages, sign-ins,
// machine rows, fold, Retry, code and stopped states as the job carries them.
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUD_SETUP_WORDS, DEFAULT_PREFERENCES, GOLDEN_STAGE_WORDS, INIT_ROW_STATES, MACHINE_GONE_LINE, MACHINE_ROW_LABEL, MCP_ADDED_WORD, SIGN_IN_ANSWERS, SIGN_IN_OPEN_STATE, SIGN_IN_STAGE_ID, STOP_LEFT_MACHINE_LINE, initBuildRows, initDiskLine, initDiskOverLine, initSignInLine, initSignInOutcome, initStageCount, initStepCounter, initStoppedAt, fmtBytesOfTotal, initTallyCount, keyUncheckedLine, signInChoices, snapshotStageLine, type InitJob, type InitRow, type InitScreen, type InitSetup, type PlaceView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { KEY_REFUSED_LINE, KEY_REFUSED_ROWS, keyStoppedRows } from "./fixtures/keyRefusedJob.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";

/** The tally as its text reads: the count, then the estimate beside it with only space between. */
const tallyText = (count: number, noun: string, used: number, total?: number): string => `${initTallyCount(count, noun)} ${fmtBytesOfTotal(used, total)}`;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const AGENTS: InitScreen = {
  id: "agents",
  title: "Agents",
  top: "Which agents go on the image",
  items: [
    { id: "claude", label: "Claude Code", size: 208 * MIB, why: "used here, 12 sessions", detail: ["on this Mac"] },
    { id: "codex", label: "Codex", size: 455 * MIB, why: "not installed here", detail: ["not on this Mac; try it on the machine"] },
    { id: "hermes", label: "Hermes Agent", size: 484 * MIB, why: "not installed here", detail: [] },
  ],
  ticks: ["claude"],
  answers: {},
  footer: [],
  tally: "agents",
};
const TOOLS: InitScreen = {
  id: "tools",
  title: "Tools",
  top: "Tools from your usage",
  items: [
    { id: "node", label: "node", size: 60 * MIB, group: "always on the image", detail: [], lock: "on" },
    { id: "gh", label: "gh", size: 12 * MIB, why: "29,623 calls", group: "from your usage", detail: [] },
    { id: "swift", label: "Swift 6.3", size: 3 * GIB, group: "from your usage", detail: [] },
  ],
  ticks: ["node", "gh"],
  answers: {},
  footer: [],
  tally: "tools",
};
const ALSO: InitScreen = { id: "also", title: "Also on this Mac", top: "What else this Mac brings", items: [{ id: "brew/jq", label: "jq", size: 2 * MIB, group: "Homebrew", detail: [] }], ticks: [], answers: {}, footer: [], tally: "more" };
/** The answers the host sends, read off the protocol so the fixture cannot drift from what a row really carries. */
const CHOICES = [...signInChoices("darwin")];
const LOGINS: InitScreen = {
  id: "logins",
  title: "Sign-ins",
  top: "How sign-ins reach the machine",
  items: [
    { id: "logins/claude", label: "Claude Code login", group: "Agents", mark: "claude", why: "Keychain", detail: ["Keychain: Claude Code-credentials", "claude auth login"], choices: CHOICES, key: { name: "ANTHROPIC_API_KEY", saved: false } },
    { id: "logins/gh", label: "GitHub CLI login", group: "Developer CLIs", mark: "gh", why: "hosts.yml", detail: ["~/.config/gh/hosts.yml", "gh auth login"], choices: CHOICES.filter(c => c.value !== "key") },
    { id: "logins/kube", label: "kubeconfig", group: "Developer CLIs", mark: "kube", why: "config", state: CLOUD_SETUP_WORDS.screen.notOnImage, detail: ["~/.kube/config"], choices: CHOICES.filter(c => c.value === "skip") },
  ],
  ticks: [],
  answers: { "logins/claude": "machine", "logins/gh": "copy", "logins/kube": "skip" },
  footer: [],
};
const WSP: InitScreen = { id: "wsp", title: "wsp for your agents on this Mac", top: "Add wsp's MCP server and skill to the agents installed here", items: [{ id: "wsp-tools/claude", label: "Claude Code", detail: [] }], ticks: ["wsp-tools/claude"], answers: {}, footer: [] };

const DISK = { fixed: 2 * GIB, total: 20 * GIB };
const JOB: InitJob = { id: "init_1", road: "manual", phase: "answering", keys: {}, step: 0, stoppable: true, disk: DISK, screens: [AGENTS, TOOLS, ALSO, LOGINS, WSP], rows: [], progress: { done: 0, total: 0 }, log: [] };
const THREAD = { id: "th_1", workspaceId: "ws_local", session: "turn_1", harness: "claude" };
const AGENT_JOB: InitJob = { ...JOB, road: "agent", phase: "agent", screens: [], thread: THREAD };
const SETUP: InitSetup = { keys: {}, home: "/Users/dev", agents: [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }, { id: "codex", name: "Codex", configured: false, takesTools: false }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, place: { id: "p_2", name: "hetzner" }, job: null };
/** A build running on the box whose page the card is on, which is where its rows are drawn. */
const AT_BOX = { id: "p_2", name: "hetzner" };
const building = (more: Partial<InitJob>): InitJob => ({ ...JOB, phase: "building", screens: [], place: AT_BOX, ...more });

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", buildsImages: false };
const box: PlaceView = { id: "p_2", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true, engine: "docker", buildsImages: true };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true, buildsImages: true };

type Call = { op: string; o?: unknown };

/** A host holding the one init job, moving it as the setup's own host does, every change landing in the store. */
function host(o: { setup?: InitSetup; job?: InitJob | null; refuse?: string } = {}) {
  const calls: Call[] = [];
  let job: InitJob | null = o.job ?? null;
  const put = (next: InitJob): InitJob => {
    job = next;
    act(() => useStore.setState({ initJob: next }));
    return next;
  };
  const fake = settingsApi({
    image: async () => ({ image: null, copies: [], projects: [] }),
    initGet: async () => ({ ...(o.setup ?? SETUP), job }),
    initStart: async (a: unknown) => {
      calls.push({ op: "start", o: a });
      return put({ ...JOB, phase: "reading", screens: [] });
    },
    initAnswer: async (a: { screen: string; ticks?: string[]; answers?: Record<string, string> }) => {
      calls.push({ op: "answer", o: a });
      if (o.refuse === a.screen) throw new Error(`the ${a.screen} screen was refused by the host`);
      const current = job ?? JOB;
      return put({ ...current, step: Math.min(current.screens.findIndex(s => s.id === a.screen) + 1, current.screens.length), drafts: (current.drafts ?? []).filter(d => d.at !== a.screen), screens: current.screens.map(s => (s.id === a.screen ? { ...s, ticks: a.ticks ?? s.ticks, answers: { ...s.answers, ...a.answers } } : s)) });
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
    initRetry: async (a: unknown) => {
      calls.push({ op: "retry", o: a });
      return job!;
    },
    initBuild: async (a: unknown) => {
      calls.push({ op: "build", o: a });
      return put({ ...(job ?? JOB), phase: "building", place: AT_BOX });
    },
    initCancel: async () => {
      calls.push({ op: "cancel" });
      return put({ ...(job ?? JOB), phase: "cancelled" });
    },
    initSignInCode: async (a: unknown) => {
      calls.push({ op: "code", o: a });
      if (o.refuse === "code") throw new Error("no sign-in for gcloud is waiting for a code from you");
      return job!;
    },
    imageBuild: async () => new Promise<never>(() => {}),
  } as Partial<Api>);
  return { ...fake, calls, put, ops: () => calls.map(c => c.op), held: () => job };
}

const card = (): HTMLElement => document.querySelector<HTMLElement>("[data-settings-page] [data-settings-card='image']")!;
const k = (key: string): HTMLElement | null => card().querySelector<HTMLElement>(`[data-k='${key}']`);
const row = (id: string): HTMLElement => card().querySelector<HTMLElement>(`[data-row='${id}']`)!;
const stepAt = (): string | null => k("recipe")?.getAttribute("data-step") ?? null;
const statePress = (): HTMLButtonElement | null => card().querySelector<HTMLButtonElement>("[data-k='image-state'] [data-k='image-press']");
const tick = (id: string): HTMLElement => within(row(id)).getByRole("checkbox");
const pick = async (picker: HTMLElement, value: string): Promise<void> => {
  fireEvent.click(picker);
  await settle();
  fireEvent.click(document.querySelector<HTMLElement>(`[data-k=option][data-value="${value}"]`)!);
  await settle();
};

/** The box's page with the job standing in the store, as a reload finds it. */
const open = async (fake: ReturnType<typeof host>, job: InitJob | null = null, at = "p_2"): Promise<void> => {
  useStore.setState({ initJob: job });
  mountSettings({ api: fake.api, at: { kind: "computer", id: at } });
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

describe("the recipe's rows", () => {
  it("opens on the two roads as the app's radios, the agent road naming its harness in the composer's picker; an agent whose thread takes no wsp tools is held with its word, and with none the road is off", async () => {
    await open(host());
    fireEvent.click(statePress()!);
    await settle();
    expect(stepAt()).toBe("choice");
    const [manual, agent] = [k("road-manual")!, k("road-agent")!];
    expect([manual.getAttribute("role"), agent.getAttribute("role")]).toEqual(["radio", "radio"]);
    expect([manual.getAttribute("aria-checked"), agent.getAttribute("aria-checked")]).toEqual(["true", "false"]);
    expect(k("harness")?.getAttribute("aria-haspopup")).toBe("menu");
    expect(k("harness")?.getAttribute("data-value")).toBe("claude");
    expect(card().querySelector("select")).toBeNull();
    expect(card().querySelector("[data-row-mark=claude]")).not.toBeNull();
    fireEvent.click(k("harness")!);
    await settle();
    const options = [...document.querySelectorAll<HTMLElement>("[data-k='option']")];
    expect(options.map(o => o.dataset["value"])).toEqual(["claude", "codex"]);
    expect(options[1]!.getAttribute("data-disabled")).not.toBeNull();
    expect(options[1]!.textContent).toContain(CLOUD_SETUP_WORDS.choice.noTools);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    cleanup();
    resetSettings();
    useStore.setState({ places: [here, box] });
    await open(host({ setup: { ...SETUP, agents: [{ id: "codex", name: "Codex", configured: false, takesTools: false }] } }));
    fireEvent.click(statePress()!);
    await settle();
    expect(k("road-agent")?.getAttribute("data-disabled")).not.toBeNull();
    expect(k("harness")).toBeNull();
    expect(k("recipe")?.textContent).toContain(CLOUD_SETUP_WORDS.choice.noTools);
  });

  it("while this computer is read the step's rows carry the spinner on the row being read and a mono word once done, and no bare sentence", async () => {
    const reading: InitJob = { ...JOB, phase: "reading", screens: [], rows: [{ id: "fact/identity", kind: "fact", label: "Identity", state: "3 found" }, { id: "fact/shell", kind: "fact", label: "Shell", state: INIT_ROW_STATES.running }] };
    await open(host({ job: reading }), reading);
    expect(stepAt()).toBe("reading");
    expect(k("recipe-title")?.textContent).toBe(CLOUD_SETUP_WORDS.reading.headline);
    const rows = [...card().querySelectorAll("[data-k='recipe'] [data-k=row]")];
    expect(rows.map(r => r.getAttribute("data-row"))).toEqual(["fact/identity", "fact/shell"]);
    expect(rows[0]!.querySelector("[data-k=state]")!.textContent).toBe("3 found");
    expect(rows[1]!.querySelector("[data-k=state][role=status]")).not.toBeNull();
  });

  it("draws each screen from the host's data, and the ticks, the tally and the meter read one selection: a row ticked moves all three before anything is sent", async () => {
    const fake = host({ job: JOB });
    await open(fake, JOB);
    expect(stepAt()).toBe("screen-agents");
    // The wsp screen the first launch answered is not shown, so the count is of the four the person sees.
    expect(k("recipe-counter")?.textContent).toBe(initStepCounter(1, 4));
    expect(k("recipe-title")?.textContent).toBe(AGENTS.top);
    const rows = [...card().querySelectorAll<HTMLElement>("[data-k='recipe'] [data-k=row]")];
    expect(rows.map(r => r.dataset["row"])).toEqual(["claude", "codex", "hermes"]);
    expect(rows.map(r => within(r).getByRole("checkbox").getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(row("claude").querySelector("[data-k=size]")!.textContent).toBe("208 MB");
    expect(row("claude").querySelector("[data-k=why]")!.textContent).toBe("used here, 12 sessions");
    expect(row("claude").querySelector("[data-row-mark=claude]")).not.toBeNull();
    expect(k("tally")?.textContent).toBe(tallyText(1, "agents", DISK.fixed + 208 * MIB + 72 * MIB, DISK.total));
    expect(k("disk")?.getAttribute("data-used")).toBe(String(DISK.fixed + 280 * MIB));
    expect(k("disk")?.getAttribute("aria-label")).toContain(initDiskLine(DISK.fixed + 280 * MIB, DISK.total));
    fireEvent.click(tick("hermes"));
    await settle();
    expect(tick("hermes").getAttribute("aria-checked")).toBe("true");
    expect(k("tally")?.textContent).toBe(tallyText(2, "agents", DISK.fixed + 692 * MIB + 72 * MIB, DISK.total));
    expect(k("disk")?.getAttribute("data-used")).toBe(String(DISK.fixed + 692 * MIB + 72 * MIB));
    expect(fake.ops()).not.toContain("answer");
    fireEvent.click(tick("codex"));
    await press("recipe-primary");
    expect(fake.calls.find(c => c.op === "answer")?.o).toEqual({ screen: "agents", ticks: ["claude", "hermes", "codex"], answers: {} });
    expect(stepAt()).toBe("screen-tools");
    expect(k("recipe-counter")?.textContent).toBe(initStepCounter(2, 4));
    // The base rows are ticked and held under their own group; the usage rows carry one number.
    expect([...card().querySelectorAll("[data-k='recipe'] [data-k=group]")].map(g => g.textContent)).toEqual(["always on the image", "from your usage"]);
    expect(tick("node").getAttribute("aria-checked")).toBe("true");
    expect((tick("node") as HTMLButtonElement).disabled || tick("node").getAttribute("aria-disabled") === "true").toBe(true);
    expect(row("node").querySelector("[data-k=state]")).toBeNull();
    expect(row("gh").querySelector("[data-k=why]")!.textContent).toBe("29,623 calls");
    expect(row("swift").querySelector("[data-k=why]")).toBeNull();
    fireEvent.click(tick("swift"));
    await settle();
    expect(k("tally")?.textContent).toBe(tallyText(3, "tools", DISK.fixed + 1147 * MIB + 72 * MIB + 3 * GIB, DISK.total));
    expect(k("disk")?.getAttribute("data-tone")).toBe("muted");
  });

  it("reads the whole image so far on every step's tally in the tone its share earns, sizes on the tools step by weight and on the agents step with none, and a tick on one step moves the next step's tally", async () => {
    const agents: InitScreen = { ...AGENTS, ticks: ["claude", "codex"] };
    const tools: InitScreen = { ...TOOLS, items: [{ id: "node", label: "node", size: 300 * MIB, group: "always on the image", detail: [], lock: "on" }, { id: "rust", label: "Rust 1.89", size: 4 * GIB, group: "from your usage", detail: [] }, { id: "swift", label: "Swift 6.3", size: 3 * GIB, group: "from your usage", detail: [] }], ticks: ["rust"] };
    const job: InitJob = { ...JOB, step: 1, disk: { fixed: 0, total: 20 * GIB }, screens: [agents, tools, ALSO, LOGINS, WSP] };
    await open(host({ job }), job);
    expect(stepAt()).toBe("screen-tools");
    const soFar = 663 * MIB + 300 * MIB + 4 * GIB;
    expect(k("tally")?.textContent).toBe(tallyText(2, "tools", soFar, 20 * GIB));
    expect(k("tally-size")?.getAttribute("data-tone")).toBe("muted");
    expect(row("rust").querySelector("[data-k=size]")!.getAttribute("data-tone")).toBe("danger");
    expect(row("node").querySelector("[data-k=size]")!.getAttribute("data-tone")).toBe("warning");
    await press("recipe-back");
    expect(stepAt()).toBe("screen-agents");
    const sizes = [...card().querySelectorAll<HTMLElement>("[data-k='recipe'] [data-k=size]")];
    expect(sizes.map(s => s.getAttribute("data-tone"))).toEqual(["muted", "muted", "muted"]);
    expect(k("tally")?.textContent).toBe(tallyText(2, "agents", soFar, 20 * GIB));
    await press("recipe-primary");
    expect(stepAt()).toBe("screen-tools");
    fireEvent.click(tick("swift"));
    await settle();
    await press("recipe-primary");
    expect(stepAt()).toBe("screen-also");
    expect(k("tally")?.textContent).toBe(tallyText(0, "more", soFar + 3 * GIB, 20 * GIB));
  });

  it("wears the meter's own table on the tally's estimate: the warning tone from 70 percent of the disk, the danger tone from 90", async () => {
    const job: InitJob = { ...JOB, step: 1, disk: { fixed: 15 * GIB, total: 20 * GIB } };
    await open(host({ job }), job);
    expect(k("tally-size")?.getAttribute("data-tone")).toBe("warning");
    expect(k("tally-size")?.className).toContain("text-warning-foreground");
    expect(k("disk")?.getAttribute("data-tone")).toBe("warning");
    fireEvent.click(tick("swift"));
    await settle();
    expect(k("tally-size")?.getAttribute("data-tone")).toBe("danger");
    expect(k("tally-size")?.className).toContain("text-destructive-foreground");
  });

  it("over the disk fills the meter in the danger tone, says by how much in its tooltip and nowhere beside the tally, and refuses Continue with that line", async () => {
    const job: InitJob = { ...JOB, step: 1, disk: { fixed: 19 * GIB, total: 20 * GIB } };
    const fake = host({ job });
    await open(fake, job);
    fireEvent.click(tick("swift"));
    await settle();
    const over = initDiskOverLine(19 * GIB + 208 * MIB + 72 * MIB + 3 * GIB - 20 * GIB);
    expect(k("disk")?.getAttribute("data-tone")).toBe("danger");
    expect(k("disk")?.getAttribute("aria-label")).toContain(over);
    expect(k("disk-over")).toBeNull();
    await press("recipe-primary");
    expect(k("recipe-refusal")?.textContent).toBe(over);
    expect(fake.ops()).not.toContain("answer");
  });

  it("the sign-ins step leads each row with its mark, draws the how in the app's picker with the host's words, holds a fixed row with its state word, and the API key choice opens a field whose key goes to the key store before the answer", async () => {
    const job: InitJob = { ...JOB, step: 3 };
    const fake = host({ job });
    await open(fake, job);
    expect(stepAt()).toBe("screen-logins");
    expect(k("recipe-counter")?.textContent).toBe(initStepCounter(4, 4));
    expect(row("logins/claude").querySelector("[data-row-mark=claude]")).not.toBeNull();
    expect(row("logins/gh").querySelector("[data-row-mark=gh]")).not.toBeNull();
    const picker = card().querySelector<HTMLElement>("[data-k='answer'][data-row='logins/claude']")!;
    expect(picker.getAttribute("aria-haspopup")).toBe("menu");
    expect(picker.textContent).toContain(SIGN_IN_ANSWERS.machine.label("darwin"));
    expect(row("logins/claude").querySelector("[data-k=why]")!.getAttribute("data-slot")).toBe("tooltip-trigger");
    const kube = card().querySelector<HTMLButtonElement>("[data-k='answer'][data-row='logins/kube']")!;
    expect(row("logins/kube").querySelector("[data-k=state]")!.textContent).toBe(CLOUD_SETUP_WORDS.screen.notOnImage);
    expect(kube.disabled).toBe(true);
    await pick(picker, "key");
    expect(card().querySelector("[data-k='key-field']")?.textContent).toContain("ANTHROPIC_API_KEY");
    expect(card().querySelector("[data-k='key-state']")?.textContent).toBe(CLOUD_SETUP_WORDS.keys.unset);
    // The pick hands focus back to its trigger, so the next row's picker opens on its own click.
    expect(document.activeElement).toBe(picker);
    await pick(card().querySelector<HTMLElement>("[data-k='answer'][data-row='logins/gh']")!, "machine");
    fireEvent.change(card().querySelector<HTMLInputElement>("[data-k='key-field'] input")!, { target: { value: "sk-ant-x-typed" } });
    await press("recipe-primary");
    expect(fake.ops().filter(op => op === "keys" || op === "answer").slice(0, 2)).toEqual(["keys", "answer"]);
    expect(fake.calls.find(c => c.op === "keys")?.o).toEqual({ rows: { "logins/claude": "sk-ant-x-typed" } });
    expect(fake.calls.find(c => c.op === "answer")?.o).toEqual({ screen: "logins", ticks: [], answers: { "logins/claude": "key", "logins/gh": "machine", "logins/kube": "skip" } });
    expect(card().textContent).not.toContain("sk-ant-x-typed");
  });

  it("keeps the step on the host: the card opens on the step the job stands at with its answers, Back moves the host's step, and the first step's Start over ends the job", async () => {
    const at2: InitJob = { ...JOB, step: 2, screens: JOB.screens.map(s => (s.id === "agents" ? { ...s, ticks: ["claude", "codex"] } : s)) };
    const fake = host({ job: at2 });
    await open(fake, at2);
    expect(stepAt()).toBe("screen-also");
    expect(k("recipe-counter")?.textContent).toBe(initStepCounter(3, 4));
    await press("recipe-back");
    expect(fake.calls.find(c => c.op === "step")?.o).toEqual({ at: 1 });
    expect(stepAt()).toBe("screen-tools");
    fake.put({ ...at2, step: 0 });
    await settle();
    expect(stepAt()).toBe("screen-agents");
    expect([...card().querySelectorAll<HTMLElement>("[data-k='recipe'] [data-k=row]")].map(r => within(r).getByRole("checkbox").getAttribute("aria-checked"))).toEqual(["true", "true", "false"]);
    expect(k("recipe-again")?.textContent).toBe(CLOUD_SETUP_WORDS.screen.again);
    await press("recipe-again");
    expect(fake.ops()).toContain("cancel");
    expect(stepAt()).toBe("choice");
  });

  it("puts every tick on the host as it happens, so a card drawn again opens on what was ticked and not on what the host last answered", async () => {
    const at1: InitJob = { ...JOB, step: 1 };
    const fake = host({ job: at1 });
    await open(fake, at1);
    expect(tick("gh").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(tick("gh"));
    await settle();
    expect(fake.calls.find(c => c.op === "draft")?.o).toEqual({ at: "tools", ticks: ["node"], answers: {} });
    expect(fake.ops()).not.toContain("answer");
    cleanup();
    await open(host({ job: fake.held() }), fake.held());
    expect(stepAt()).toBe("screen-tools");
    expect([...card().querySelectorAll<HTMLElement>("[data-k='recipe'] [data-k=row]")].map(r => within(r).getByRole("checkbox").getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(k("tally")?.textContent).toBe(tallyText(1, "tools", DISK.fixed + 208 * MIB + 60 * MIB, DISK.total));
  });

  it("says a refusal on a screen in the host's words in the slot, and the screen stays", async () => {
    const fake = host({ job: JOB, refuse: "agents" });
    await open(fake, JOB);
    await press("recipe-primary");
    expect(k("recipe-refusal")?.textContent).toBe("the agents screen was refused by the host");
    expect(stepAt()).toBe("screen-agents");
  });

  it("the agent step is the thread's own line in the mono block with the spinner, and its link opens the thread and leaves Settings", async () => {
    const fake = host({ job: AGENT_JOB });
    useStore.setState({ settingsOpen: true });
    await open(fake, AGENT_JOB);
    expect(stepAt()).toBe("agent");
    expect(k("recipe-title")?.textContent).toBe(CLOUD_SETUP_WORDS.agent.headline);
    expect(k("line")?.textContent).toBe(CLOUD_SETUP_WORDS.agent.waiting);
    expect(k("spinner")).not.toBeNull();
    expect(k("recipe-primary")).toBeNull();
    fake.put({ ...AGENT_JOB, line: "$ recipe_scan" });
    await settle();
    expect(k("line")?.textContent).toBe("$ recipe_scan");
    fireEvent.click(k("open-thread")!);
    expect([useStore.getState().selectedId, useStore.getState().selectedThreadId, useStore.getState().settingsOpen]).toEqual(["ws_local", "th_1", false]);
  });

  it("an agent road started from this card that ended without the recipe opens the card on its agent step, and draws no build under it", async () => {
    const stopped: InitJob = { ...AGENT_JOB, phase: "failed", place: AT_BOX, error: "the thread ended without writing /Users/me/.wsp/recipe.json" };
    await open(host({ job: stopped }), stopped);
    expect(stepAt()).toBe("agent");
    expect(k("recipe-title")?.textContent).toBe(CLOUD_SETUP_WORDS.agent.failed);
    expect(k("build")).toBeNull();
    // Retry runs the same agent for the same computer.
    const fake = host({ job: stopped });
    cleanup();
    await open(fake, stopped);
    await press("recipe-primary");
    expect(fake.calls.find(c => c.op === "start")?.o).toEqual({ road: "agent", harness: "claude", on: "p_2" });
  });

  it("a turn that ended without the recipe says so on the agent step with its last line, Retry starts the same agent again and Start over goes back to the road; one stopped from elsewhere says the thread ended", async () => {
    const stopped: InitJob = { ...AGENT_JOB, phase: "failed", line: "Run: wsp recipe scan --json", error: "the thread ended without writing /Users/me/.wsp/recipe.json" };
    const fake = host({ job: stopped });
    await open(fake, stopped);
    fireEvent.click(statePress()!);
    await settle();
    expect(stepAt()).toBe("agent");
    expect(k("recipe-title")?.textContent).toBe(CLOUD_SETUP_WORDS.agent.failed);
    expect(k("recipe-sentence")?.textContent).toBe(stopped.error);
    expect(k("line")?.textContent).toBe(stopped.line);
    expect(k("spinner")).toBeNull();
    expect(k("recipe-primary")?.textContent).toBe(CLOUD_SETUP_WORDS.agent.retry);
    await press("recipe-primary");
    expect(fake.calls.find(c => c.op === "start")?.o).toEqual({ road: "agent", harness: "claude", on: "p_2" });
    fake.put({ ...stopped, id: "init_3", phase: "cancelled", error: undefined, line: undefined } as InitJob);
    await settle();
    expect(k("recipe-sentence")?.textContent).toBe(CLOUD_SETUP_WORDS.agent.stopped);
    await press("recipe-again");
    expect(stepAt()).toBe("choice");
  });
});

describe("the build's rows", () => {
  const signing: InitJob = building({
    phase: "signing-in",
    rows: [
      { id: "agent/claude", kind: "agent", label: "Claude Code", state: MCP_ADDED_WORD },
      { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: "done", ms: 12_000, lines: ["sandbox from base"] },
      { id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "done" },
      { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "Sign in to GitHub CLI", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", code: "8F4A-C21B" },
      { id: "sign-in/claude", kind: "sign-in", tool: "claude", label: "Sign in to Claude Code", state: INIT_ROW_STATES.keySet },
      // The host's note names the command the machine ran; no row shows it.
      { id: "sign-in/codex", kind: "sign-in", tool: "codex", label: "Sign in to Codex", ...initSignInOutcome("copied", "darwin"), detail: "codex login --api-key exited 0" },
      { id: "sign-in/wrangler", kind: "sign-in", tool: "wrangler", label: "Sign in to Cloudflare Wrangler", ...initSignInOutcome("not-signed-in", "darwin"), detail: "wrangler login exited 1; no sign-in within 16m" },
      { id: "stage/snapshotting", kind: "stage", label: GOLDEN_STAGE_WORDS.snapshotting, state: INIT_ROW_STATES.running, lines: [snapshotStageLine(13 * GIB)], since: Date.now() - 41_000 },
      { id: "stage/sealed", kind: "stage", label: GOLDEN_STAGE_WORDS.sealed, state: "waiting" },
    ],
    progress: { done: 2, total: 5 },
  });

  it("while the sign-in stage runs is the sign-ins alone, each with its mark, the code in the large mono and the page's keycap on an action line only where there is something to do; once the last settles the list is back with the sign-ins one stage, the running stage open with its seconds and a done one opening on a click", async () => {
    const fake = host({ job: signing });
    await open(fake, signing);
    expect(k("build")?.getAttribute("data-step")).toBe("slide");
    expect(k("build-title")?.textContent).toBe(CLOUD_SETUP_WORDS.build.slideHeadline);
    expect(k("build-sentence")?.textContent).toBe(CLOUD_SETUP_WORDS.build.slideTop);
    const slide = [...card().querySelectorAll<HTMLElement>("[data-k=signin]")];
    expect(slide.map(r => [r.dataset["row"], r.dataset["acts"], r.children.length])).toEqual([
      ["sign-in/gh", "true", 2],
      ["sign-in/claude", "false", 1],
      ["sign-in/codex", "false", 1],
      ["sign-in/wrangler", "true", 2],
    ]);
    expect(card().querySelector("[data-row='agent/claude']"), "the MCP rows are not build stages").toBeNull();
    expect(card().querySelector("[data-row='stage/snapshotting']"), "the stage list gives way to the sign-ins").toBeNull();
    const gh = row("sign-in/gh");
    expect(gh.querySelector("[data-k=code]")!.className).toContain("text-[20px]");
    expect(gh.querySelector("[data-k=code]")!.textContent).toBe("8F4A-C21B");
    expect(gh.querySelector("[data-row-mark=gh]")).not.toBeNull();
    expect(gh.querySelector("[data-k=state]")!.textContent).toBe("waiting for you");
    expect(gh.querySelector<HTMLAnchorElement>("[data-k=open]")!.getAttribute("href")).toBe("https://github.com/login/device");
    expect(gh.querySelector("[data-k=open]")!.getAttribute("target")).toBe("_blank");
    expect(gh.querySelector("[data-k=act] [data-k=why]")!.textContent).toBe(initSignInLine({ state: SIGN_IN_OPEN_STATE, code: "8F4A-C21B" }));
    expect(row("sign-in/claude").querySelector("[data-k=state]")!.textContent).toBe("key set");
    expect(row("sign-in/codex").querySelector("[data-k=state]")!.textContent).toBe("copied from this Mac");
    expect(row("sign-in/wrangler").querySelector("[data-k=act] [data-k=retry]")).not.toBeNull();
    for (const r of slide) expect(r.firstElementChild!.querySelector("[data-k=state]"), `${r.dataset["row"]}: the state word on the name's line`).not.toBeNull();
    expect(slide.map(r => r.querySelector("[data-k=mark-column]") !== null)).toEqual([true, true, true, true]);
    expect(card().textContent).not.toMatch(/exited|codex login|wrangler login/);
    expect(card().querySelectorAll("[data-k=signin] [title]:not([data-k=state])")).toHaveLength(0);
    expect(card().querySelector("[data-badge], .animate-status-pulse")).toBeNull();
    fake.put({ ...signing, phase: "building", rows: signing.rows.map(r => (r.id === "sign-in/gh" || r.id === "sign-in/wrangler" ? { id: r.id, kind: r.kind, tool: r.tool, label: r.label, ...initSignInOutcome("signed-in", "darwin") } : r)), progress: { done: 3, total: 5 } });
    await settle();
    expect(k("build")?.getAttribute("data-step")).toBe("building");
    expect(k("build-title")?.textContent).toBe(CLOUD_SETUP_WORDS.build.headline);
    expect(k("progress")?.getAttribute("aria-valuenow")).toBe("60");
    expect(card().querySelector("[data-k='image-state']"), "the build stands in the state row's place").toBeNull();
    const stages = [...card().querySelectorAll<HTMLElement>("[data-k='build'] [data-k=card] li[data-k=row]:not([data-k=sign-ins] li)")];
    expect(stages.map(r => r.dataset["row"])).toEqual(["stage/creating", "stage/ready", SIGN_IN_STAGE_ID, "stage/snapshotting", "stage/sealed"]);
    const signIns = row(SIGN_IN_STAGE_ID);
    expect([signIns.dataset["state"], signIns.dataset["open"]]).toEqual(["done", "false"]);
    fireEvent.click(within(signIns).getByRole("button"));
    expect([...signIns.querySelectorAll<HTMLElement>("[data-k=sign-ins] [data-k=row]")].map(r => r.dataset["row"])).toEqual(["sign-in/gh", "sign-in/claude", "sign-in/codex", "sign-in/wrangler"]);
    expect([...signIns.querySelectorAll<HTMLElement>("[data-k=sign-ins] [data-k=row]")].map(r => r.querySelector("[data-k=mark-column]") !== null)).toEqual([true, true, true, true]);
    expect(row("sign-in/gh").querySelector("[data-k=open]")).toBeNull();
    const snap = row("stage/snapshotting");
    expect(snap.dataset["open"]).toBe("true");
    expect(snap.querySelector("[data-k=lines]")!.textContent).toBe(snapshotStageLine(13 * GIB));
    expect(snap.querySelector<HTMLElement>("[data-k=lines]")!.style.getPropertyValue("--stage-lines")).toBe("1");
    expect(snap.querySelector("[data-k=elapsed]")!.textContent).toMatch(/^4[0-9]s$/);
    expect(row("stage/creating").querySelector("[data-k=elapsed]"), "a done stage has no clock").toBeNull();
    const creating = row("stage/creating");
    expect(creating.dataset["open"]).toBe("false");
    fireEvent.click(within(creating).getByRole("button"));
    expect(creating.dataset["open"]).toBe("true");
    expect(creating.querySelector("[data-k=lines]")!.textContent).toBe("sandbox from base");
    expect(row("stage/sealed").querySelector("[role=button]")).toBeNull();
  });

  it("a sign-in that ran out folds its stage with the failed glyph, open on its own and folding on a click, and Retry on its row runs it again; while the seal runs Cancel is held with why in the slot", async () => {
    const sealing: InitJob = building({
      phase: "sealing",
      stoppable: false,
      rows: [
        { id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "done" },
        { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "Sign in to GitHub CLI", ...initSignInOutcome("not-signed-in", "darwin"), detail: "no sign-in within 16m" },
        { id: "stage/snapshotting", kind: "stage", label: GOLDEN_STAGE_WORDS.snapshotting, state: INIT_ROW_STATES.running },
      ],
    });
    const job = { ...sealing, progress: initStageCount(initBuildRows(sealing.rows).rows) };
    expect(job.progress).toEqual({ done: 1, total: 3 });
    const fake = host({ job });
    await open(fake, job);
    const stage = row(SIGN_IN_STAGE_ID);
    expect(stage.querySelector("[data-k=state]")!.textContent).toBe("not signed in");
    expect(stage.querySelector("[data-glyph]")!.getAttribute("data-glyph")).toBe("failed");
    expect(stage.dataset["open"]).toBe("true");
    const head = stage.querySelector<HTMLElement>(':scope > div[role="button"]')!;
    fireEvent.click(head);
    expect(stage.dataset["open"]).toBe("false");
    expect(stage.querySelector("[data-glyph]")!.getAttribute("data-glyph")).toBe("failed");
    fireEvent.click(head);
    fireEvent.click(row("sign-in/gh").querySelector<HTMLElement>("[data-k=retry]")!);
    await settle();
    expect(fake.calls.find(c => c.op === "retry")?.o).toEqual({ tool: "gh" });
    expect(k("build-cancel")?.hasAttribute("disabled")).toBe(true);
    expect(k("build-refusal")?.textContent).toBe(CLOUD_SETUP_WORDS.build.cannotStop);
    expect(k("build-cancel")?.className).toContain("hover:text-destructive-foreground");
  });

  it("a build a Linux host worded for itself reads as its outcome, not its sentence: the copy is over with no Retry, and the run-out decides its stage", async () => {
    const rows: InitRow[] = [
      { id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "done" },
      { id: "sign-in/codex", kind: "sign-in", tool: "codex", label: "Sign in to Codex", ...initSignInOutcome("copied", "linux") },
      { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "Sign in to GitHub CLI", ...initSignInOutcome("not-signed-in", "linux"), detail: "no sign-in within 16m" },
      { id: "stage/snapshotting", kind: "stage", label: GOLDEN_STAGE_WORDS.snapshotting, state: INIT_ROW_STATES.running },
    ];
    const job = building({ phase: "sealing", stoppable: false, rows, progress: initStageCount(initBuildRows(rows).rows) });
    const fake = host({ job });
    await open(fake, job);
    expect(k("build-title")?.textContent).toBe(CLOUD_SETUP_WORDS.build.headline);
    expect(row("sign-in/codex").querySelector("[data-k=state]")!.textContent).toBe("copied from this computer");
    expect(row("sign-in/codex").querySelector("[data-k=retry]")).toBeNull();
    expect(row(SIGN_IN_STAGE_ID).querySelector("[data-glyph]")!.getAttribute("data-glyph")).toBe("failed");
    fireEvent.click(row("sign-in/gh").querySelector<HTMLElement>("[data-k=retry]")!);
    await settle();
    expect(fake.calls.find(c => c.op === "retry")?.o).toEqual({ tool: "gh" });
    expect(card().textContent).not.toMatch(/\bMac\b/);
  });

  it("a stage waiting on the account's machine cap reads so, open on the cap line", async () => {
    const job = building({ rows: [{ id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: INIT_ROW_STATES.slot, lines: ["sandbox from base", "Solari account at its machine cap; waiting 30s for a slot (5/20). Nothing is killed."] }], progress: { done: 0, total: 1 } });
    await open(host({ job }), job);
    const creating = row("stage/creating");
    expect(creating.querySelector("[data-k=state]")!.textContent).toBe(INIT_ROW_STATES.slot);
    expect(creating.dataset["open"]).toBe("true");
    expect(creating.querySelector("[data-k=lines]")!.textContent).toContain("at its machine cap");
  });

  it("a sign-in whose page hands a code back sends it for that tool; a refused submit says so in the slot and the field stays", async () => {
    const PASTED = "4/0AfakeCodeFromThePage";
    const job = building({ phase: "signing-in", rows: [{ id: "sign-in/gcloud", kind: "sign-in", tool: "gcloud", label: "Sign in to Google Cloud", state: SIGN_IN_OPEN_STATE, page: "https://accounts.google.com/o/oauth2/auth", finish: "code" }], progress: { done: 0, total: 1 } });
    const fake = host({ job, refuse: "code" });
    await open(fake, job);
    expect(card().querySelectorAll("[data-k=code-field]")).toHaveLength(1);
    fireEvent.change(k("code-field")!, { target: { value: PASTED } });
    fireEvent.click(k("code-submit")!);
    await settle();
    expect(fake.calls.find(c => c.op === "code")?.o).toEqual({ tool: "gcloud", code: PASTED });
    expect(k("build-refusal")?.textContent).toBe("no sign-in for gcloud is waiting for a code from you");
    expect(k("code-field")).not.toBeNull();
    expect(card().textContent).not.toContain(PASTED);
  });

  it("a build the person stopped says so with the stage it stopped at, which reads stopped and wears no cross, and the stages after it still waiting", async () => {
    const job = building({
      phase: "cancelled",
      stoppable: false,
      error: `${initStoppedAt("while creating the machine")} ${MACHINE_GONE_LINE}`,
      rows: [
        { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: INIT_ROW_STATES.stopped, lines: ["sandbox from base"] },
        { id: "stage/snapshotting", kind: "stage", label: GOLDEN_STAGE_WORDS.snapshotting, state: INIT_ROW_STATES.waiting },
      ],
      progress: { done: 0, total: 2 },
    });
    await open(host({ job }), job);
    expect(k("build-title")?.textContent).toBe(CLOUD_SETUP_WORDS.build.stopped);
    expect(k("build-sentence")?.textContent).toBe(job.error);
    expect(row("stage/creating").querySelector("[data-k=state]")!.textContent).toBe(INIT_ROW_STATES.stopped);
    expect(row("stage/creating").querySelector("[data-k=state]")!.className).not.toContain("text-destructive-foreground");
    expect(row("stage/creating").querySelector("[data-glyph=failed]")).toBeNull();
    expect(row("stage/snapshotting").querySelector("[data-k=state]")!.textContent).toBe(INIT_ROW_STATES.waiting);
    expect(k("build-primary")?.textContent).toBe(CLOUD_SETUP_WORDS.build.again);
  });

  it("a machine the provider would not take is a row like any other, its name in words, a filled dot and nothing to open; once taken it reads gone with a check", async () => {
    const job = building({
      phase: "cancelled",
      stoppable: false,
      error: `Stopped while creating the machine. ${STOP_LEFT_MACHINE_LINE}`,
      rows: [
        { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: INIT_ROW_STATES.stopped, lines: ["sandbox from base"] },
        { id: "machine/b_dlb9oeig", kind: "machine", label: MACHINE_ROW_LABEL, state: INIT_ROW_STATES.retrying, detail: "getaddrinfo ENOTFOUND api.getsolari.com" },
      ],
      progress: { done: 0, total: 1 },
    });
    const fake = host({ job });
    await open(fake, job);
    const machine = row("machine/b_dlb9oeig");
    expect(machine.textContent).toContain(MACHINE_ROW_LABEL);
    expect(machine.textContent).not.toContain("b_dlb9oeig");
    expect(machine.querySelector("[data-k=state]")!.textContent).toBe(INIT_ROW_STATES.retrying);
    expect(machine.querySelector("[data-glyph]")!.getAttribute("data-glyph")).toBe("dot");
    expect(machine.querySelector("[role=button]")).toBeNull();
    fake.put({ ...job, rows: job.rows.map(r => (r.kind === "machine" ? { id: r.id, kind: r.kind, label: r.label, state: INIT_ROW_STATES.gone } : r)) });
    await settle();
    expect(row("machine/b_dlb9oeig").querySelector("[data-k=state]")!.textContent).toBe(INIT_ROW_STATES.gone);
    expect(row("machine/b_dlb9oeig").querySelector("svg")).not.toBeNull();
  });

  it("a saved key refused at build time draws the job the host leaves: the first stage failed with the refusal, the rows after it never reached, nothing counted as done, and Change the key as the way on", async () => {
    const job = building({ phase: "failed", rows: KEY_REFUSED_ROWS, progress: initStageCount(initBuildRows(KEY_REFUSED_ROWS).rows), error: KEY_REFUSED_LINE, keyRefused: true, place: { id: "solari", name: "solari" } });
    expect(job.progress.done).toBe(0);
    await open(host({ job, setup: { ...SETUP, keys: { solari: true } } }), job, "solari");
    expect(k("build-title")?.textContent).toBe(CLOUD_SETUP_WORDS.build.failed);
    expect(k("progress")?.getAttribute("aria-valuenow")).toBe("0");
    expect(row("stage/creating").getAttribute("data-state")).toBe(INIT_ROW_STATES.failed);
    expect(within(row("stage/creating")).getByText(KEY_REFUSED_LINE)).toBeDefined();
    expect(row(SIGN_IN_STAGE_ID).getAttribute("data-state")).toBe(INIT_ROW_STATES.skipped);
    expect([...card().querySelectorAll("[data-k='build'] [data-row]")].map(r => r.getAttribute("data-state"))).not.toContain(INIT_ROW_STATES.done);
    expect(k("build-primary")?.textContent).toBe(CLOUD_SETUP_WORDS.keys.changeKey);
  });

  it("a build that could not ask the provider about the key offers Start over, since the saved key may be fine", async () => {
    const line = keyUncheckedLine("fetch failed", "solari");
    const rows = keyStoppedRows(line);
    const job = building({ phase: "failed", rows, progress: { done: 0, total: rows.length }, error: line });
    await open(host({ job }), job);
    expect(k("build-sentence")?.textContent).toBe(line);
    expect(k("build-primary")?.textContent).toBe(CLOUD_SETUP_WORDS.build.again);
  });
});
