// SPDX-License-Identifier: AGPL-3.0-only
// The image's own build drawn inside the Image card of the computer it runs
// on: its stages, the sign-ins with their page, code and field, Retry, Cancel
// asked once and able to stop the build while it still waits on the place, a
// stopped build saying what was left running, and Change the key where the
// provider refused the saved one.
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUD_SETUP_WORDS, DEFAULT_PREFERENCES, INIT_ROW_STATES, KEY_REFUSED, MACHINE_ROW_LABEL, PROVIDER_KEY_WORDS, STOP_LEFT_MACHINE_LINE, keyRefusedLine, savedKeyRefusedLine, type InitJob, type InitRow, type InitScreen, type InitSetup, type PlaceView, type SealedImageView } from "@wsp/protocol";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { ADD_COMPUTER_WORDS } from "../src/settings/format.js";
import { IMAGE_WORDS } from "../src/settings/image.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";
import { KEY_REFUSED_LINE, KEY_REFUSED_ROWS } from "./fixtures/keyRefusedJob.js";

const AGENTS: InitScreen = { id: "agents", title: "Agents", top: "Which agents go on the image", items: [{ id: "claude", label: "Claude Code", detail: [] }], ticks: ["claude"], answers: {}, footer: [], tally: "agents" };
const SETUP: InitSetup = { keys: { solari: true }, home: "/Users/dev", agents: [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, place: { id: "p_2", name: "hetzner" }, job: null };
const NOTHING: SealedImageView = { image: null, copies: [], projects: [] };

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", buildsImages: false };
const box: PlaceView = { id: "p_2", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true, engine: "docker", buildsImages: true };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true, buildsImages: true };

const stage = (id: string, label: string, state: string, more: Partial<InitRow> = {}): InitRow => ({ id: `stage/${id}`, kind: "stage", label, state, ...more });
const STAGES: InitRow[] = [stage("creating", "Creating the machine", INIT_ROW_STATES.done, { ms: 4_000 }), stage("installing-tools", "Installing your tools", INIT_ROW_STATES.running, { lines: ["pnpm: fetched 212 packages", "pnpm: linking"] }), stage("sealed", "Saving your image", INIT_ROW_STATES.waiting)];
const BUILDING: InitJob = { id: "init_1", road: "manual", phase: "building", keys: { solari: true }, step: 1, stoppable: true, screens: [AGENTS], rows: STAGES, progress: { done: 1, total: 3 }, log: [], place: { id: "p_2", name: "hetzner" } };
const signIn = (more: Partial<InitRow>): InitRow => ({ id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: INIT_ROW_STATES.open, ...more });
const SIGNING: InitJob = { ...BUILDING, phase: "signing-in", rows: [STAGES[0]!, signIn({ page: "https://github.com/login/device", code: "ABCD-1234", finish: "code" }), STAGES[2]!], needsYou: { what: "sign in to GitHub CLI login", since: 1 } };

type Call = { op: string; o?: unknown };

function host(job: InitJob | null, o: { view?: SealedImageView; placeGate?: Promise<void> } = {}) {
  const calls: Call[] = [];
  let current = job;
  const put = (next: InitJob): InitJob => {
    current = next;
    act(() => useStore.setState({ initJob: next }));
    return next;
  };
  const fake = settingsApi({
    image: async () => o.view ?? NOTHING,
    initGet: async () => ({ ...SETUP, job: current }),
    initStart: async (a: unknown) => {
      calls.push({ op: "start", o: a });
      return put({ ...BUILDING, id: "init_2", phase: "answering", step: 0, rows: [], place: undefined as never });
    },
    initAnswer: async (a: { screen: string }) => {
      calls.push({ op: "answer", o: a });
      return put({ ...current!, step: 1 });
    },
    initBuild: async (a: unknown) => {
      calls.push({ op: "build", o: a });
      if (o.placeGate !== undefined) await o.placeGate;
      if (current?.phase === "cancelled") return current;
      return put({ ...BUILDING, id: current!.id });
    },
    initCancel: async () => {
      calls.push({ op: "cancel" });
      return put({ ...current!, phase: "cancelled" });
    },
    initRetry: async (a: unknown) => {
      calls.push({ op: "retry", o: a });
      return current!;
    },
    initSignInCode: async (a: unknown) => {
      calls.push({ op: "code", o: a });
      return current!;
    },
    initKeys: async (a: unknown) => {
      calls.push({ op: "keys", o: a });
      return SETUP;
    },
    imageBuild: async () => new Promise<never>(() => {}),
  } as Partial<Api>);
  return { ...fake, calls, put, ops: () => calls.map(c => c.op) };
}

const card = (): HTMLElement => document.querySelector<HTMLElement>("[data-settings-page] [data-settings-card='image']")!;
const k = (key: string): HTMLElement | null => card().querySelector<HTMLElement>(`[data-k='${key}']`);
const build = (): HTMLElement | null => k("build");
const stateRow = (): HTMLElement => card().querySelector<HTMLElement>("[data-k='image-state']")!;

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

describe("the first build in the Image card", () => {
  it("draws the build's stages under the card of the computer it runs on, the running stage open on its lines", async () => {
    useStore.setState({ initJob: BUILDING });
    await open(host(BUILDING).api, "p_2");
    expect(card().querySelector("[data-k='image-state']"), "the build stands in the state row's place").toBeNull();
    expect(build()?.getAttribute("data-step")).toBe("building");
    expect(k("build-title")?.textContent).toBe(CLOUD_SETUP_WORDS.build.headline);
    expect([...card().querySelectorAll("[data-k='build'] [data-k='row']")].map(r => [r.getAttribute("data-row"), r.getAttribute("data-state")])).toEqual([
      ["stage/creating", INIT_ROW_STATES.done],
      ["stage/installing-tools", INIT_ROW_STATES.running],
      ["stage/sealed", INIT_ROW_STATES.waiting],
    ]);
    expect(card().querySelector("[data-row='stage/installing-tools'] [data-k='lines']")?.textContent).toContain("linking");
    expect(k("progress")?.getAttribute("aria-valuenow")).toBe("33");
    // While it runs the build is the page's one act: the recipe's presses stand held with where it builds.
    expect(k("recipe")).toBeNull();
  });

  it("is drawn on no other computer's card, which holds its presses with where the image is building", async () => {
    useStore.setState({ initJob: BUILDING });
    await open(host(BUILDING).api, "solari");
    expect(build()).toBeNull();
    expect(k("image-refusal")?.textContent).toBe(IMAGE_WORDS.buildingOn("hetzner"));
  });

  it("while a sign-in waits, its row is in the card with the code, the page opening in the browser and the field that takes a code back; the code goes to the host for that tool and is kept nowhere", async () => {
    useStore.setState({ initJob: SIGNING });
    const fake = host(SIGNING);
    await open(fake.api, "p_2");
    expect(build()?.getAttribute("data-step")).toBe("slide");
    expect(k("build-title")?.textContent).toBe(CLOUD_SETUP_WORDS.build.slideHeadline);
    expect(card().querySelector("[data-k='image-state']")).toBeNull();
    const row = card().querySelector<HTMLElement>("[data-k='signin'][data-row='sign-in/gh']")!;
    expect(row.querySelector("[data-k='code']")?.textContent).toBe("ABCD-1234");
    const page = row.querySelector<HTMLAnchorElement>("[data-k='open']")!;
    expect(page.getAttribute("href")).toBe("https://github.com/login/device");
    expect(page.getAttribute("target")).toBe("_blank");
    expect(page.getAttribute("rel")).toContain("noopener");
    const field = row.querySelector<HTMLInputElement>("[data-k='code-field']")!;
    fireEvent.change(field, { target: { value: "  gho_code_x  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();
    expect(fake.calls.filter(c => c.op === "code")).toEqual([{ op: "code", o: { tool: "gh", code: "gho_code_x" } }]);
    expect(row.querySelector<HTMLInputElement>("[data-k='code-field']")?.value).toBe("");
    expect(JSON.stringify(useStore.getState())).not.toContain("gho_code_x");
    expect(JSON.stringify(useSettingsStore.getState())).not.toContain("gho_code_x");
  });

  it("a sign-in that ran out offers Retry, which runs it again for that tool", async () => {
    const ranOut: InitJob = { ...BUILDING, phase: "signing-in", rows: [STAGES[0]!, signIn({ state: "not signed in", login: "not-signed-in" }), STAGES[2]!] };
    useStore.setState({ initJob: ranOut });
    const fake = host(ranOut);
    await open(fake.api, "p_2");
    fireEvent.click(card().querySelector("[data-row='sign-in/gh'] [data-k='retry']")!);
    await settle();
    expect(fake.calls.filter(c => c.op === "retry")).toEqual([{ op: "retry", o: { tool: "gh" } }]);
  });

  it("Cancel asks once: Keep building takes the question back and sends nothing, Stop the build ends the job", async () => {
    useStore.setState({ initJob: BUILDING });
    const fake = host(BUILDING);
    await open(fake.api, "p_2");
    expect(k("build-cancel")?.className).not.toContain("bg-destructive");
    await press("build-cancel");
    expect(k("build-note")?.textContent).toBe(CLOUD_SETUP_WORDS.build.cancelWhy);
    await press("build-keep");
    expect(k("build-note")).toBeNull();
    expect(fake.ops()).not.toContain("cancel");
    await press("build-cancel");
    // The trigger is quiet; the confirmation is the one solid destructive button.
    expect(k("build-cancel")).toBeNull();
    expect(k("build-sure")?.className).toContain("bg-destructive");
    expect(k("build-keep")?.className).not.toContain("bg-destructive");
    await press("build-sure");
    expect(fake.ops()).toEqual(["cancel"]);
    expect(build()?.getAttribute("data-step")).toBe("cancelled");
    expect(k("build-title")?.textContent).toBe(CLOUD_SETUP_WORDS.build.stopped);
  });

  it("while the seal runs Cancel is held, and why stands under the build rather than on a hover", async () => {
    const sealing: InitJob = { ...BUILDING, phase: "sealing", stoppable: false };
    useStore.setState({ initJob: sealing });
    const fake = host(sealing);
    await open(fake.api, "p_2");
    expect(k("build-cancel")?.hasAttribute("disabled")).toBe(true);
    expect(k("build-refusal")?.textContent).toBe(CLOUD_SETUP_WORDS.build.cannotStop);
    fireEvent.click(k("build-cancel")!);
    await settle();
    expect(fake.ops()).not.toContain("cancel");
  });

  it("a build that was stopped says what was left running, with the machine still being removed as its own row, and Start over opens the recipe", async () => {
    const stopped: InitJob = {
      ...BUILDING,
      phase: "cancelled",
      error: `The build was stopped at installing your tools. ${STOP_LEFT_MACHINE_LINE}`,
      rows: [...STAGES.map(r => (r.state === INIT_ROW_STATES.running ? { ...r, state: INIT_ROW_STATES.stopped } : r)), { id: "machine/b_1", kind: "machine", label: MACHINE_ROW_LABEL, state: INIT_ROW_STATES.retrying }],
    };
    useStore.setState({ initJob: stopped });
    await open(host(stopped).api, "p_2");
    expect(k("build-title")?.textContent).toBe(CLOUD_SETUP_WORDS.build.stopped);
    expect(k("build-sentence")?.textContent).toContain(STOP_LEFT_MACHINE_LINE);
    const machine = card().querySelector("[data-k='build'] [data-row='machine/b_1']")!;
    expect(machine.getAttribute("data-state")).toBe(INIT_ROW_STATES.retrying);
    expect(machine.textContent).toContain(MACHINE_ROW_LABEL);
    await press("build-primary");
    expect(build()).toBeNull();
    expect(k("recipe")?.getAttribute("data-step")).toBe("choice");
  });

  it("a saved key the provider refused offers Change the key: the provider's own key field in the card, and a key it takes goes on to the recipe", async () => {
    const refused: InitJob = { ...BUILDING, phase: "failed", keyRefused: true, error: KEY_REFUSED_LINE, rows: KEY_REFUSED_ROWS, place: { id: "solari", name: "solari" } };
    useStore.setState({ initJob: refused });
    const fake = host(refused);
    await open(fake.api, "solari");
    expect(build()?.getAttribute("data-step")).toBe("failed");
    expect(k("build-primary")?.textContent).toBe(CLOUD_SETUP_WORDS.keys.changeKey);
    await press("build-primary");
    const field = card().querySelector<HTMLElement>("[data-provider='solari']")!;
    expect(field.querySelector("[data-k='provider-name']")?.textContent).toBe(PROVIDER_KEY_WORDS["solari"]!.name);
    // The host holds a key for it, the refused one, so the field replaces it as the add panel's does.
    expect(field.querySelector("[data-k='cloud-save']")?.textContent).toBe(ADD_COMPUTER_WORDS.replace);
    expect(field.querySelector<HTMLInputElement>("[data-k='cloud-key']")?.placeholder).toBe(ADD_COMPUTER_WORDS.replaceKey);
    fireEvent.change(field.querySelector<HTMLInputElement>("[data-k='cloud-key']")!, { target: { value: "slr_live_x" } });
    fireEvent.click(field.querySelector("[data-k='cloud-save']")!);
    await settle();
    expect(fake.calls.filter(c => c.op === "keys")).toEqual([{ op: "keys", o: { provider: "solari", key: "slr_live_x" } }]);
    expect(k("recipe")?.getAttribute("data-step")).toBe("choice");
    expect(JSON.stringify(useStore.getState())).not.toContain("slr_live_x");
    // The job was about the key just replaced: closing the recipe does not bring it back.
    await press("recipe-close");
    expect(build()).toBeNull();
    expect(stateRow().querySelector("[data-k='image-press']")?.textContent).toBe(IMAGE_WORDS.buildHere);
  });

  it("a Box key the provider refuses in Change the key says Box refused it under the Box field", async () => {
    const boxCloud: PlaceView = { id: "box", kind: "provider", name: "box", default: false, rateUsdPerHour: 0.018, takesForks: true, buildsImages: true };
    useStore.setState({ places: [here, box, solari, boxCloud] });
    const refused: InitJob = { ...BUILDING, phase: "failed", keyRefused: true, error: savedKeyRefusedLine("401 Unauthorized", "box"), rows: KEY_REFUSED_ROWS, place: { id: "box", name: "box" } };
    useStore.setState({ initJob: refused });
    const fake = host(refused);
    // The host holds a Box key, the one refused at build time, so Box's page draws its card.
    const refuse = settingsApi({ ...fake.api, initGet: async () => ({ ...SETUP, keys: { solari: true, box: true }, job: refused }), initKeys: async () => Promise.reject(new RequestError(keyRefusedLine("401 Unauthorized", "box"), KEY_REFUSED)) } as Partial<Api>);
    await open(refuse.api, "box");
    await press("build-primary");
    const field = card().querySelector<HTMLElement>("[data-provider='box']")!;
    fireEvent.change(field.querySelector<HTMLInputElement>("[data-k='cloud-key']")!, { target: { value: "box_live_x" } });
    fireEvent.click(field.querySelector("[data-k='cloud-save']")!);
    await settle();
    expect(field.querySelector("[data-k='cloud-refusal']")?.textContent).toContain("Box by ASCII refused this key: 401 Unauthorized");
    expect(field.textContent).not.toContain("Solari");
  });

  it("Cancel stops a build still waiting on the place: the recipe's Build press offers it while it is on its way, and a stop there says so and builds nothing", async () => {
    let letGo: () => void = () => {};
    const gate = new Promise<void>(r => (letGo = r));
    const answering: InitJob = { ...BUILDING, phase: "answering", step: 0, rows: [], progress: { done: 0, total: 0 }, place: undefined as never };
    delete (answering as { place?: unknown }).place;
    useStore.setState({ initJob: answering });
    const fake = host(answering, { placeGate: gate });
    await open(fake.api, "p_2");
    expect(k("recipe")?.getAttribute("data-step")).toBe("screen-agents");
    fireEvent.click(k("recipe-primary")!);
    await settle();
    expect(fake.ops()).toContain("build");
    await press("recipe-cancel");
    expect(fake.ops()).toContain("cancel");
    await act(async () => letGo());
    await settle();
    expect(k("recipe-refusal")?.textContent).toBe(CLOUD_SETUP_WORDS.build.stopped);
    expect(k("recipe")?.getAttribute("data-step")).toBe("choice");
    expect(build()).toBeNull();
  });

  it("says the build is on screen while it is drawn, and nothing once the page is left", async () => {
    useStore.setState({ initJob: BUILDING });
    const mounted = await (async () => {
      const m = mountSettings({ api: host(BUILDING).api, at: { kind: "computer", id: "p_2" } });
      await settle();
      return m;
    })();
    expect(useSettingsStore.getState().buildShown).toBe("p_2");
    act(() => useSettingsStore.getState().go({ kind: "group", group: "appearance" }));
    await settle();
    expect(useSettingsStore.getState().buildShown).toBeNull();
    mounted.unmount();
  });
});
