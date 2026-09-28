// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer goes on to the sign-ins that live on that computer: once a
// box has joined, each agent there whose login every workspace on it shares
// stands as a row with its state and Sign in, which runs the agent's own
// sign-in there and draws its page and code under the row. The row reads the
// host's report again once the host says the agents there changed.
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, type AgentsReport, type AgentsSignInEvent, type AgentsTarget, type EventUnion, type PlaceView, type SealedImageView } from "@wsp/protocol";
import { AGENTS_LIST_WORDS } from "../src/components/agents/agentsRows.js";
import { forgetAgentsReports } from "../src/components/agents/useAgentsReport.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useAdds } from "../src/settings/adds.js";
import { ADD_COMPUTER_WORDS } from "../src/settings/format.js";
import { absentOf } from "../src/settings/places.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";

const AT = "2026-09-12T11:00:00.000Z";
const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", buildsImages: false };
const box: PlaceView = { id: "p_2", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true, engine: "docker", buildsImages: true };
const NO_IMAGE: SealedImageView = { image: null, copies: [], projects: [] };

const reportWith = (codex: AgentsReport["agents"][number]["signIn"]): AgentsReport => ({
  ...AGENTS_REPORT,
  target: { placeId: box.id },
  agents: AGENTS_REPORT.agents.map(a => (a.id === "codex" ? { ...a, signIn: codex } : a)),
});

/** A host that answers one report per read, in turn, and records every sign-in it is asked to run. */
function host(reports: AgentsReport[]) {
  const started: { target: AgentsTarget; agent: string; server: string | undefined; step(e: Omit<AgentsSignInEvent, "type" | "signInId">): void }[] = [];
  const reads: AgentsTarget[] = [];
  const fake = settingsApi({
    image: async () => NO_IMAGE,
    agentsRead: async (target: AgentsTarget) => (reads.push(target), reports[Math.min(reads.length, reports.length) - 1]!),
    agentsSignIn: async (target: AgentsTarget, agent: string, server: string | undefined, onStep: (e: AgentsSignInEvent) => void) => {
      const signInId = `si_${started.length + 1}`;
      started.push({ target, agent, server, step: e => onStep({ type: "agents.signIn", signInId, ...e }) });
      return { signInId, stop: () => {}, off: () => {} };
    },
  } as Partial<Api>);
  return { ...fake, started, reads };
}

const ssh = (): HTMLElement => document.querySelector<HTMLElement>("[data-settings-page] [data-k='road-ssh']")!;
const card = (): HTMLElement | null => ssh().querySelector<HTMLElement>("[data-settings-card='sign-ins']");
const row = (agent: string): HTMLElement | null => card()?.querySelector<HTMLElement>(`[data-settings-row='sign-in-${agent}']`) ?? null;

const joined = async (api: Api): Promise<void> => {
  useAdds.setState({ jobs: { a_1: { addId: "a_1", address: "root@hetzner", startedAt: AT, state: "done", steps: [], placeId: box.id } }, putAway: null });
  mountSettings({ api, at: { kind: "group", group: "computers" } });
  await settle();
  fireEvent.click(document.querySelector("[data-add-road='ssh']")!);
  await settle();
};

beforeEach(() => {
  resetSettings();
  forgetAgentsReports();
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false }, places: [here, box], initJob: null, goldenFrames: {} });
});

afterEach(() => cleanup());

describe("Add a computer goes on to the sign-ins on it", () => {
  it("offers each agent whose login lives on the computer, runs its sign-in there, draws the code, and reads the row again once it lands", async () => {
    const fake = host([reportWith("none"), reportWith("signed-in")]);
    await joined(fake.api);
    expect(fake.reads).toEqual([{ placeId: box.id }]);
    expect(card()?.querySelector("[data-settings-head]")?.textContent).toBe(ADD_COMPUTER_WORDS.signInsOn("hetzner"));
    // Why a sign-in is asked here while the image asks none: the login is the computer's, shared by every workspace there.
    expect(card()?.querySelector("[data-settings-lede]")?.textContent).toBe("Codex keeps one login for every workspace on hetzner, so sign in once here.");
    expect(row("codex")!.querySelector("[data-settings-description]")?.textContent).toBe(AGENTS_LIST_WORDS.roads.device);
    // Claude Code's login there stays in the home of that computer's login, which no workspace shares: not offered.
    expect([...card()!.querySelectorAll("[data-settings-row]")].map(r => r.getAttribute("data-settings-row"))).toEqual(["sign-in-codex"]);
    expect(row("codex")!.querySelector("[data-settings-word]")?.textContent).toBe(AGENTS_LIST_WORDS.needsSignIn);
    fireEvent.click(row("codex")!.querySelector<HTMLButtonElement>("[data-k='act-sign-in']")!);
    await settle();
    expect(fake.started.map(s => [s.target, s.agent, s.server])).toEqual([[{ placeId: box.id }, "codex", undefined]]);
    act(() => fake.started[0]!.step({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "WXYZ-1234", paste: false }));
    expect(card()!.querySelector("[data-k='sign-in-code']")?.textContent).toBe("WXYZ-1234");
    expect(row("codex")!.querySelector("[data-settings-word]")?.textContent).toBe(AGENTS_LIST_WORDS.waitingOnYou);
    expect(row("codex")!.querySelector("[data-k='act-cancel']")).not.toBeNull();
    act(() => fake.started[0]!.step({ state: "signed-in" }));
    act(() => fake.push({ type: "agents.changed", seq: 1, target: { placeId: box.id } } as EventUnion));
    await settle();
    expect(fake.reads).toHaveLength(2);
    expect(card()!.querySelector("[data-k='sign-in-flow']")).toBeNull();
    expect(row("codex")!.querySelector("[data-settings-word]")?.textContent).toBe(AGENTS_LIST_WORDS.signedIn);
    expect(row("codex")!.querySelector("[data-k='act-sign-in']")).toBeNull();
  });

  it("says the tool's own words when the sign-in there fails, and offers Sign in again", async () => {
    const fake = host([reportWith("none")]);
    await joined(fake.api);
    fireEvent.click(row("codex")!.querySelector<HTMLButtonElement>("[data-k='act-sign-in']")!);
    await settle();
    act(() => fake.started[0]!.step({ state: "failed", said: "device code expired" }));
    expect(card()!.querySelector("[data-k='sign-in-refused']")?.textContent).toContain("device code expired");
    expect(row("codex")!.querySelector("[data-k='act-sign-in']")).not.toBeNull();
  });

  it("holds Sign in with the away word while the computer is not answering", async () => {
    const offline: PlaceView = { ...box, present: false, lastSeenAt: AT };
    useStore.setState({ places: [here, offline] });
    const fake = host([reportWith("none")]);
    await joined(fake.api);
    const held = row("codex")!.querySelector<HTMLElement>("[data-act-hover='sign-in']");
    expect(held?.getAttribute("title")).toBe(absentOf(offline, Date.now())!.away);
    fireEvent.click(held!.querySelector("button")!);
    await settle();
    expect(fake.started).toEqual([]);
  });

  it("names every agent whose login lives there in the one sentence", () => {
    expect(ADD_COMPUTER_WORDS.signInsWhy(["Codex", "Gemini CLI"], "spoo")).toBe("Codex and Gemini CLI keep one login for every workspace on spoo, so sign in once here.");
  });

  it("draws no card where no agent on the computer keeps a login its workspaces share", async () => {
    const fake = host([{ ...reportWith("none"), agents: AGENTS_REPORT.agents.filter(a => a.id !== "codex") }]);
    await joined(fake.api);
    expect(fake.reads).toHaveLength(1);
    expect(card()).toBeNull();
  });
});
