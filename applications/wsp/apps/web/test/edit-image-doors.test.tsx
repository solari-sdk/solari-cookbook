// SPDX-License-Identifier: AGPL-3.0-only
// Every Edit image outside a computer's Image card lands on that computer's
// page with the recipe open in its card: the task panel's on a fork, and the
// cloud page's agents list. While the image builds on another computer the
// door lands on the page and leaves the recipe shut, as the card's own Edit is
// held there.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, type InitJob, type InitSetup, type PlaceView, type WorkspaceView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_LIST_WORDS } from "../src/components/agents/agentsRows.js";
import { AgentsSurface } from "../src/components/agents/AgentsSurface.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { IMAGE_WORDS } from "../src/settings/image.js";
import { openImageRecipe } from "../src/settings/openAt.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { mountSettings, pageAt, resetSettings, settingsApi, settle } from "./settings-harness.js";

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", buildsImages: false };
const box: PlaceView = { id: "p_2", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true, engine: "docker", buildsImages: true };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true, buildsImages: true };
const SETUP: InitSetup = { keys: { solari: true }, home: "/Users/dev", agents: [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null };
const FORK: WorkspaceView = { id: "ws_f", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, name: "ws_f", kind: "cloud", machineId: "fk_1", phase: "running", golden: "", createdAt: "2026-09-11T00:00:00.000Z", provider: "solari" };
const BUILDING: InitJob = { id: "init_1", road: "manual", phase: "building", keys: {}, step: 1, stoppable: true, screens: [], rows: [], progress: { done: 1, total: 3 }, log: [], place: { id: "solari", name: "solari" } };

const api = (): Api => settingsApi({ initGet: async () => ({ ...SETUP, job: useStore.getState().initJob }), image: async () => ({ image: null, copies: [], projects: [] }), initStart: async () => ({}) as InitJob } as Partial<Api>).api;
const card = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-settings-page] [data-settings-card='image']");

beforeEach(() => {
  resetSettings();
  useSettingsStore.setState({ recipeAsked: null });
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false }, places: [here, box, solari], initJob: null, goldenFrames: {}, workspaces: [FORK] });
});
afterEach(() => cleanup());

describe("an Edit image outside the Image card", () => {
  it("on a fork's task panel opens Settings on the cloud the fork stands at, with its recipe asked for", async () => {
    useStore.setState({ api: settingsApi({ agentsRead: async () => AGENTS_REPORT } as Partial<Api>).api });
    render(
      <TooltipProvider>
        <AgentsSurface workspaceId="ws_f" />
      </TooltipProvider>,
    );
    await settle();
    // A fork's one act on every row is Edit image, since what it holds is the image's.
    fireEvent.click(document.querySelector<HTMLElement>('[data-agents-row="agent-claude"] [data-row-trigger]')!);
    const edit = [...document.querySelectorAll<HTMLButtonElement>("[data-agents-detail] [data-detail-acts] button")];
    expect(edit.map(b => b.textContent)).toEqual([AGENTS_LIST_WORDS.editImage]);
    fireEvent.click(edit[0]!);
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "computer", id: "solari" });
    expect(useSettingsStore.getState().recipeAsked).toBe("solari");
  });

  it("on a fork whose cloud this host holds no key for is held, its reason on the hover and never the Add word", async () => {
    useStore.setState({ places: [here, box], api: settingsApi({ agentsRead: async () => AGENTS_REPORT } as Partial<Api>).api });
    render(
      <TooltipProvider>
        <AgentsSurface workspaceId="ws_f" />
      </TooltipProvider>,
    );
    await settle();
    fireEvent.click(document.querySelector<HTMLElement>('[data-agents-row="agent-claude"] [data-row-trigger]')!);
    const edit = document.querySelector<HTMLElement>("[data-agents-detail] [data-detail-acts] [title]");
    expect(edit?.getAttribute("title")).toBe(AGENTS_LIST_WORDS.editImageHeld);
    fireEvent.click(document.querySelector<HTMLElement>("[data-agents-detail] [data-detail-acts] button")!);
    expect(useStore.getState().settingsOpen).toBe(false);
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=agents-back]")!);
    fireEvent.click(screen.getByRole("radio", { name: /^Skills/ }));
    expect(document.querySelector("[data-k=agents-add]")?.parentElement?.getAttribute("title")).toBe(AGENTS_LIST_WORDS.editImageHeld);
  });

  it("lands on that computer's page with the recipe open in its card, once", async () => {
    openImageRecipe("p_2");
    mountSettings({ api: api() });
    await settle();
    expect(pageAt()).toBe("computer:p_2");
    expect(card()?.querySelector("[data-k='recipe']")?.getAttribute("data-step")).toBe("choice");
    expect(useSettingsStore.getState().recipeAsked).toBeNull();
    // Closed, it stays closed: the ask was one press, not a standing state of the page.
    fireEvent.click(card()!.querySelector<HTMLElement>("[data-k='recipe-close']")!);
    await settle();
    expect(card()?.querySelector("[data-k='recipe']")).toBeNull();
  });

  it("drops an ask no card took once the page moves, so a later visit opens no recipe", async () => {
    openImageRecipe("p_2");
    useSettingsStore.getState().go({ kind: "group", group: "appearance" });
    expect(useSettingsStore.getState().recipeAsked).toBeNull();
    useSettingsStore.getState().go({ kind: "computer", id: "p_2" });
    mountSettings({ api: api() });
    await settle();
    expect(card()?.querySelector("[data-k='recipe']")).toBeNull();
  });

  it("leaves the recipe shut while the image builds on another computer, saying where", async () => {
    useStore.setState({ initJob: BUILDING });
    openImageRecipe("p_2");
    mountSettings({ api: api() });
    await settle();
    expect(pageAt()).toBe("computer:p_2");
    expect(card()?.querySelector("[data-k='recipe']")).toBeNull();
    expect(card()?.querySelector("[data-k='image-refusal']")?.textContent).toContain(IMAGE_WORDS.buildingOn("Solari"));
    expect(useSettingsStore.getState().recipeAsked).toBeNull();
  });
});
