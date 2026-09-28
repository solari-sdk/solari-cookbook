// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Computers: the list off the host's own rows, which it draws and
// which it leaves out, each row's facts and state word; a computer's own page
// with its lines, its connection, the agents on it and what the recipe put
// beside them, the workspaces standing on it and the two acts; the cloud's
// page with the image behind its row; and the one-field sheet that adds
// another computer.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InitJob, COPY_CURRENT, DEFAULT_PREFERENCES, PLACES_TICKET_REFUSAL, PLACES_WORDS, PLACE_CONNECTS, PLACE_LOGIN_REFUSED_KIND, PlaceAddStep, absentRoad, fmtBytes, fmtSize, imageCopyStaysLine, placeAddSheetWord, placeDaemonBehind, placeNoDialLine, provisionWord, type AgentsReport, type AgentsTarget, type EventUnion, type InitSetup, type PlaceAddJob, type PlaceProvision, type PlaceView, type SealedImage, type SessionView, type WorkspaceStatus, type WorkspaceView, PLACE_INSTALL, PROVIDER_KEY_WORDS } from "@wsp/protocol";
import { render } from "@testing-library/react";
import { makeApi, ProtocolClient, RequestError, type Api, type SshLogin } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AddComputer } from "../src/settings/AddComputer.js";
import { useAdds } from "../src/settings/adds.js";
import { ADD_COMPUTER_WORDS, WHERE_WORDS } from "../src/settings/format.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { IMAGE_WORDS } from "../src/settings/image.js";
import { absentOf } from "../src/settings/places.js";
import { useSettingsStore, type SettingsAt } from "../src/settings/settingsStore.js";
import { SettingsRow } from "../src/sidebar/SettingsRow.js";
import { ScriptedSocket, type Frame } from "./scripted-socket.js";
import { descriptionOf, lineLabels, lineOf, mountSettings, pageAt, resetSettings, rowOf, settingsApi, settle, wordOf } from "./settings-harness.js";
import { pickOption } from "./select.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

/** What the host says about its own setup: which keys it holds, which is the rule a cloud row stands under, and
 * the agents on this computer, which are this computer's own rows. */
const setupOf = (over: Partial<InitSetup> = {}): InitSetup => ({ keys: { solari: false }, home: "/Users/dev", agents: [], pricing: null, job: null, ...over }) as InitSetup;

/** A Linux box the ssh installer hands back: it runs Docker, so it can hold copies of the image. */
const box: PlaceView = {
  id: "p_2",
  kind: "computer",
  name: "hetzner",
  default: false,
  present: true,
  takesForks: true,
  engine: "docker",
  os: "Ubuntu 24.04",
  shape: { cpu: 2, memMb: 4096 },
  diskFreeBytes: 38 * 1024 ** 3,
  joinedAt: "2026-09-12T11:00:00.000Z",
  lastSeenAt: "2026-09-12T11:59:00.000Z",
};

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", shape: { cpu: 8, memMb: 16384 }, diskFreeBytes: 210 * 1024 ** 3 };
const laptop: PlaceView = {
  id: "p_1",
  kind: "computer",
  name: "old-macbook",
  default: false,
  present: false,
  takesForks: true,
  engine: "none",
  os: "Ubuntu 24.04",
  agents: ["claude", "codex"],
  shape: { cpu: 4, memMb: 8192 },
  diskFreeBytes: 91 * 1024 ** 3,
  lastSeenAt: "2026-09-12T10:00:00.000Z",
};
const ascii: PlaceView = { id: "box", kind: "provider", name: "box", default: false, shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 40 * 1024 ** 3, rateUsdPerHour: 0.018, takesForks: true };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true };
const AT = "2026-09-12T11:00:00.000Z";

/** The workspaces the app holds, as the sidebar lists them: this computer's own, and the forks, whether they stand
 * at a provider or on a computer somebody joined. */
const workspace = (id: string, kind: WorkspaceView["kind"], machineId: string): WorkspaceView => ({ id, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, name: id, kind, machineId, phase: "running", golden: "", createdAt: "2026-09-11T00:00:00.000Z" });
const mine = workspace("ws_a", "local", "local");
const onLaptop: WorkspaceView = { ...workspace("ws_b", "cloud", "ctr_9f"), place: "p_1" };
const fork = (id: string): WorkspaceView => workspace(id, "cloud", `fk_${id}`);
/** A fork stamped with the cloud it was made at, which is what stands its row on that cloud's row. */
const atSolari = (id: string): WorkspaceView => ({ ...fork(id), provider: "solari" });
/** One thread on a workspace, in the shape the sidebar's tree reads. */
const session = (id: string, workspaceId: string): SessionView => ({ id, workspaceId, harness: "claude", status: "completed", prompt: id, startedBy: "person", startedAt: Date.parse(AT) });

/** The api the Computers pages read: the setup, and whatever else a case names. */
const computersApi = (over: Partial<Api> = {}, setup: InitSetup = setupOf()) => settingsApi({ initGet: async () => setup, ...over });

/** The list page, drawn: one row per computer by id. */
const listIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-place-row]")].map(row => row.dataset["placeRow"] ?? "");
const listRow = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-settings-page] [data-place-row='${id}']`)!;
const stateOf = (id: string): string | undefined => listRow(id).querySelector("[data-settings-word]")?.textContent ?? undefined;
/** A row's facts as its chips say them, one after another. */
const factsOf = (id: string): string => [...listRow(id).querySelectorAll("[data-chip]")].map(chip => chip.textContent).join(" · ");
const openPage = (id: string): void => {
  fireEvent.click(listRow(id));
};

/** The agent rows of the open page, by the name a person reads. */
const agentTitles = (): string[] => [...document.querySelectorAll("[data-settings-page] [data-agents-row] [data-row-title]")].map(t => t.textContent ?? "");
/** A report with nothing on it. */
const EMPTY_REPORT: AgentsReport = { ...AGENTS_REPORT, agents: [], skills: [], servers: [], projects: [] };
/** The word the laptop's own page reads it by while it is away, which is what every act there is held with. */
const stateOfPage = (): string | undefined => absentOf(laptop, Date.now())?.away;
const lineValue = (k: string): string | undefined => document.querySelector(`[data-settings-page] [data-k='${k}'] [data-settings-word]`)?.textContent ?? undefined;

let live: ProtocolClient | undefined;

beforeEach(() => {
  resetSettings();
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false } });
});

afterEach(() => {
  live?.close();
  live = undefined;
  cleanup();
});

const mountComputers = async (api: Api, at: SettingsAt = { kind: "group", group: "computers" }): Promise<void> => {
  mountSettings({ api, at });
  await settle();
};

describe("the Computers list", () => {
  it("lists this computer first with its default mark and facts, and a computer that is not answering with its word in the slot", async () => {
    useStore.setState({ places: [here, laptop], workspaces: [mine, onLaptop] });
    await mountComputers(computersApi().api);
    expect(listIds()).toEqual(["here", "p_1"]);
    expect(listRow("here").querySelector("[data-settings-title]")?.textContent).toBe("This Mac");
    expect(listRow("here").textContent).not.toContain("zingzy-mbp");
    expect(listRow("here").querySelector("[data-settings-mark]")?.textContent).toBe("default");
    expect(factsOf("here")).toBe(`${here.shape!.cpu} cores · 16 GB · 210 GB free · 1 task`);
    expect(stateOf("here")).toBeUndefined();
    // The slot holds the one word for the silence, in the words every other surface says it in.
    expect(stateOf("p_1")).toBe("no answer");
    expect(factsOf("p_1")).toMatch(/ cores · .* GB · 91 GB free · 1 task$/);
    // Facts are chips in the mono fact face, each whole on hover.
    const chip = listRow("p_1").querySelector("[data-chip]")!;
    expect(chip.className).toContain("font-mono");
    expect(chip.getAttribute("title")).toBe(chip.textContent);
  });

  it("says this computer's own daemon is not running in the slot, rather than listing this Mac as perfectly fine", async () => {
    const silent = { id: mine.id, phase: "running", machineState: "running", reach: { state: "unreachable" }, machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, kind: "local", size: { cpu: 8, memMb: 16384 }, name: mine.name, golden: "", createdAt: mine.createdAt } as unknown as WorkspaceStatus;
    useStore.setState({ places: [here], workspaces: [mine], statuses: { [mine.id]: silent } });
    await mountComputers(computersApi().api);
    expect(stateOf("here")).toBe("no daemon");
    expect(listRow("here").textContent).not.toContain("Unreachable");
  });

  it("leaves out a fact a computer has not reported, so a row that has said nothing carries its name alone and keeps its height", async () => {
    useStore.setState({ places: [{ id: "p_2", kind: "computer", name: "attic", default: false, present: true }] });
    await mountComputers(computersApi().api);
    expect(factsOf("p_2")).toBe("");
    expect(listRow("p_2").textContent).not.toMatch(/[-\u2014]/);
    expect(listRow("p_2").querySelector("[data-slot=skeleton]")).toBeNull();
    expect(listRow("p_2").className).toContain("min-h-24");
  });

  it("counts the workspaces standing on each row off the list the sidebar shows, and draws every row the host lists and no other", async () => {
    useStore.setState({ places: [here, ascii], workspaces: [mine, fork("ws_x"), fork("ws_y")] });
    await mountComputers(computersApi().api);
    expect(listIds()).toEqual(["here", "box"]);
    expect(factsOf("here")).toContain("1 task");
    expect(factsOf("box")).toBe("cloud · $0.018/hr · 2 tasks");
    expect(document.querySelector("[data-place-row='solari']")).toBeNull();
    expect(screen.queryByText("Where agents run")).toBeNull();
  });

  it("draws a cloud row once this host holds its key, named as a person reads it, with what it took this month in its own row and no foot under the card", async () => {
    const api = computersApi({ spend: async () => [{ place: "solari", monthUsd: 1.23, rateUsdPerHour: 0.11 }] } as Partial<Api>, setupOf({ keys: { solari: true } })).api;
    useStore.setState({ places: [here, solari], workspaces: [atSolari("ws_s")] });
    await mountComputers(api);
    expect(listIds()).toEqual(["here", "solari"]);
    expect(listRow("solari").querySelector("[data-settings-title]")?.textContent).toBe("Solari");
    expect(factsOf("solari")).toBe("cloud · $0.11/hr · 1 task · $1.23 this month");
    expect(document.querySelector("[data-k='places-spend']")).toBeNull();
    expect(document.body.textContent?.match(/this month/g)?.length).toBe(1);
  });

  it("draws a cloud row the host lists even with no key held and no workspace on it, as a stand-in serving that cloud is", async () => {
    useStore.setState({ places: [here, solari], workspaces: [] });
    await mountComputers(computersApi({}, setupOf({ keys: {} })).api);
    expect(listIds()).toEqual(["here", "solari"]);
  });

  it("draws a cloud row as soon as its key is saved, with no reload: the places, the landings and the setup are read again", async () => {
    let keys: Record<string, boolean> = { box: false, solari: false };
    let places: PlaceView[] = [here];
    const saved: unknown[] = [];
    const api = computersApi({
      initGet: async () => setupOf({ keys }),
      placesList: async () => ({ places, adds: [] }),
      initKeys: async (asked: unknown) => {
        saved.push(asked);
        keys = { ...keys, box: true };
        places = [here, ascii];
        return setupOf({ keys });
      },
    } as Partial<Api>).api;
    useStore.setState({ places });
    await mountComputers(api);
    expect(listIds()).toEqual(["here"]);
    // A landing asked before the save was answered without the new computer, so it goes with the places read.
    useStore.setState({ landings: { pr_1: null } });
    await act(async () => {
      await useStore.getState().saveKeys({ provider: "box", key: "ascii_live_fake" });
    });
    await settle();
    expect(saved).toEqual([{ provider: "box", key: "ascii_live_fake" }]);
    expect(listIds()).toEqual(["here", "box"]);
    expect(useStore.getState().landings).toEqual({});
    expect(useSettingsStore.getState().reads.setup?.keys["box"]).toBe(true);
  });

  it("reads the state slot in one order: the computer that is not answering, then the recipe on it, then the daemon behind", async () => {
    const running: PlaceProvision = { state: "running", addId: "a_1", recipeAt: AT, startedAt: AT, rows: [], at: { label: "uv", index: 3, of: 7 } };
    const failed: PlaceProvision = {
      state: "done",
      addId: "a_1",
      recipeAt: AT,
      startedAt: AT,
      finishedAt: AT,
      rows: [
        { id: "tools/gh", label: "GitHub CLI", outcome: "failed", note: "no release for this chip" },
        { id: "tools/uv", label: "uv", outcome: "failed", note: "the script exited 1" },
        ...Array.from({ length: 5 }, (_, at) => ({ id: `tools/t${at}`, label: `t${at}`, outcome: "installed" as const })),
      ],
    };
    const busy = { ...box, id: "p_busy", name: "busy", provision: running };
    const broke = { ...box, id: "p_broke", name: "broke", provision: failed };
    const gone = { ...laptop, id: "p_gone", name: "gone", provision: running };
    const behind = { ...box, id: "p_old", name: "old", daemonVersion: 1 };
    useStore.setState({ places: [here, busy, broke, gone, behind] });
    await mountComputers(computersApi().api);
    expect(stateOf("p_busy")).toBe(provisionWord(running));
    expect(stateOf("p_broke")).toBe("2 of 7 failed: GitHub CLI, uv");
    expect(stateOf("p_gone")).toBe("no answer");
    expect(stateOf("p_old")).toBe(placeDaemonBehind(behind));
  });

  it("draws Add a computer on the page under the list, with no button to open it and no cloud to connect, and a row opens the computer's page", async () => {
    useStore.setState({ places: [here, box] });
    await mountComputers(computersApi().api);
    expect(screen.queryByRole("button", { name: PLACES_WORDS.addComputer })).toBeNull();
    expect(document.querySelector("[data-k='add-computer'] [data-add-road='ssh']")).toBeTruthy();
    expect(document.querySelector("[data-k='connect-provider']")).toBeNull();
    openPage("p_2");
    expect(pageAt()).toBe("computer:p_2");
  });

  it("asks the host once for the month and follows the meter, and says no money at all on a window that may not read it", async () => {
    let asks = 0;
    const fake = computersApi({
      spend: async () => {
        asks += 1;
        return Promise.reject(new Error(PLACES_TICKET_REFUSAL));
      },
    } as Partial<Api>);
    useStore.setState({ places: [here, ascii], workspaces: [fork("ws_x")] });
    await mountComputers(fake.api);
    await waitFor(() => expect(asks).toBe(1));
    expect(factsOf("box")).not.toContain("this month");
    act(() => fake.push({ type: "workspace.cost", workspaceId: "ws_x", phase: "running", rateUsdPerHour: 0.16, awakeMs: 60_000, accruedUsd: 0.41, at: AT, seq: 1 } as EventUnion));
    await settle();
    expect(asks).toBe(1);
  });
});

describe("a computer's own page", () => {
  const withWorkspaces = (): void => {
    useStore.setState({
      places: [here, laptop],
      workspaces: [{ id: "ws_b", name: "spoo-fix", kind: "cloud", machineId: "ctr_9f", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, place: "p_1", phase: "running", golden: "", createdAt: "2026-09-11T00:00:00.000Z", home: "/home/dev" }] as never,
      sessions: { ws_b: [session("s1", "ws_b"), session("s2", "ws_b")] },
    });
  };

  it("says its facts as lines, the login it dials and how long the last dial took as rows, and the workspaces on it as lines", async () => {
    // Stamps against the clock the page reads, so the words hold whatever day the suite runs.
    // A minute past the hour, since the page reads a clock quantised to the minute.
    const seen = new Date(Date.now() - 2 * 3_600_000 - 60_000).toISOString();
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", lastSeenAt: seen, road: { ssh: "root@65.21.4.12" }, dialled: { at: seen, answered: true, roundTripMs: 14 }, joinedAt: new Date(Date.now() - 3_600_000 - 60_000).toISOString() };
    useStore.setState({ places: [here, vps], workspaces: [{ ...onLaptop, place: "p_3", name: "spoo-fix" }], sessions: { ws_b: [session("s1", "ws_b"), session("s2", "ws_b")] } });
    await mountComputers(computersApi(dialling()).api, { kind: "computer", id: "p_3" });
    // The facts are lines with the value at the right and no sentence under them; the whole is on hover.
    expect(lineLabels()).toEqual([WHERE_WORDS.system, WHERE_WORDS.size, WHERE_WORDS.diskFree, WHERE_WORDS.joined, "spoo-fix"]);
    expect(lineValue("system")).toBe("Ubuntu 24.04, last seen 2 h ago");
    expect(lineOf("system")?.getAttribute("title")).toBe(WHERE_WORDS.systemHover);
    expect(lineValue("size")).toBe(fmtSize(vps.shape!, "cores"));
    expect(lineValue("disk-free")).toBe(fmtBytes(vps.diskFreeBytes!));
    expect(lineValue("joined")).toBe("1 h ago");
    expect(lineOf("system")?.querySelector("[data-settings-description]")).toBeNull();
    // The connection card: the address and when it last answered with how long the frame took, beside Try.
    expect(wordOf("address")).toBe("root@65.21.4.12 over ssh");
    expect(wordOf("answered")).toBe(`${absentRoad({ name: "vps", awayMs: 2 * 3_600_000 + 60_000 }).answered}, 14 ms`);
    expect(descriptionOf("answered")).toBe(WHERE_WORDS.answeredDescription);
    expect(document.querySelector("[data-settings-page] [data-k='workspace-line'] [data-settings-word]")?.textContent).toBe("Running 2 threads");
    // The rows and the lines stand at their own two heights.
    expect(rowOf("address")?.className).toContain("h-16");
    expect(lineOf("system")?.className).toContain("h-11");
  });

  it("says a box on the ssh dial-back dials back over ssh under its login, and never that it dials in from this computer's loopback", async () => {
    const spoo: PlaceView = { ...laptop, id: "p_4", name: "spoo", present: true, road: { ssh: "root@spoo", from: "127.0.0.1", back: { boxPort: 4640 } } };
    useStore.setState({ places: [here, spoo] });
    await mountComputers(computersApi(dialling()).api, { kind: "computer", id: "p_4" });
    expect(wordOf("address")).toBe("root@spoo over ssh");
    expect(descriptionOf("address")).toBe(WHERE_WORDS.addressBackDescription("dials back over ssh (127.0.0.1:4640 on spoo)"));
    expect(descriptionOf("address")).toBe("It dials back over ssh (127.0.0.1:4640 on spoo).");
    const page = document.querySelector("[data-settings-page]")?.textContent ?? "";
    expect(page).not.toContain("dials in");
    expect(page).not.toContain("127.0.0.1 dials in");
  });

  it("this Mac's page has no Connection card and no acts, and reads its agents, skills and servers off this computer", async () => {
    const asked: AgentsTarget[] = [];
    useStore.setState({ places: [here] });
    await mountComputers(computersApi({ agentsRead: async (target: AgentsTarget) => (asked.push(target), AGENTS_REPORT) }).api, { kind: "computer", id: "here" });
    for (const k of ["remove", "update", "dial", "address", "answered", "joined"]) expect(document.querySelector(`[data-settings-page] [data-k='${k}']`)).toBeNull();
    expect(asked).toEqual([{ placeId: "here" }]);
    expect(agentTitles()).toEqual(["Claude Code", "Codex", "OpenCode", "Pi"]);
    // The manager stands where the Agents card stood, the section named for all three kinds.
    expect(document.querySelector("[data-settings-card='agents'] section")?.getAttribute("aria-label")).toBe("Agents, MCP servers and skills");
    expect(document.querySelector("[data-settings-card='agents'] [data-k=agents-line]")?.textContent).toBe("Agents, MCP servers and skills on this Mac and in its projects.");
    expect(document.querySelector("[data-settings-card='agents'] [data-settings-head]")).toBeNull();
  });

  it("says the page covers each project once the computer holds any, and only then", async () => {
    useStore.setState({ places: [here] });
    const projects = [{ id: "pr_app", name: "app", path: "~/code/app" }];
    await mountComputers(computersApi({ agentsRead: async () => ({ ...AGENTS_REPORT, projects }) }).api, { kind: "computer", id: "here" });
    expect(document.querySelector("[data-k=agents-line]")?.textContent).toBe("Agents, MCP servers and skills on this Mac and in its projects.");
  });

  it("says so when a computer reported no agent at all, the head naming that computer", async () => {
    useStore.setState({ places: [here, { ...laptop, present: true, agents: [] }] });
    await mountComputers(computersApi({ agentsRead: async () => EMPTY_REPORT }).api, { kind: "computer", id: "here" });
    expect(document.querySelector("[data-k='agents-empty'] .border-dashed")?.textContent).toBe("no agents");
    expect(document.querySelector("[data-k=agents-line]")?.textContent).toBe("Agents, MCP servers and skills on this Mac.");
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "p_1" }));
    await settle();
    expect(document.querySelector("[data-k='agents-empty'] .border-dashed")?.textContent).toBe("no agents");
    expect(document.querySelector("[data-k=agents-line]")?.textContent).toBe("Agents, MCP servers and skills on old-macbook.");
  });

  it("reads a joined computer by its id, and holds every act with the page's away word while it does not answer", async () => {
    const asked: AgentsTarget[] = [];
    useStore.setState({ places: [here, laptop] });
    await mountComputers(computersApi({ agentsRead: async (target: AgentsTarget) => (asked.push(target), AGENTS_REPORT) }).api, { kind: "computer", id: "p_1" });
    expect(asked).toEqual([{ placeId: "p_1" }]);
    const again = screen.getByRole("button", { name: "Read again" });
    expect(again.hasAttribute("disabled")).toBe(true);
    expect(again.parentElement?.getAttribute("title")).toBe(stateOfPage());
    // Agents has no search, so no toolbar; Add stands on the other tabs.
    fireEvent.click(screen.getByRole("radio", { name: /^Skills/ }));
    expect(document.querySelector("[data-k=agents-add]")?.parentElement?.getAttribute("title")).toBe(stateOfPage());
  });

  it("puts the recipe's rows that are not on the computer under the rows as lines, and draws no recipe card", async () => {
    const provision: PlaceProvision = {
      state: "done",
      addId: "a_1",
      recipeAt: AT,
      startedAt: AT,
      finishedAt: AT,
      rows: [
        { id: "agents/claude", label: "Claude Code", outcome: "installed" },
        { id: "agents/codex", label: "Codex", outcome: "failed", note: "npm exited 1" },
        { id: "tools/gh", label: "GitHub CLI", outcome: "failed" },
        { id: "agents/files/skills", label: "code-review", outcome: "installed", kind: "file" },
        { id: "agents/mcp/linear", label: "linear", outcome: "skipped", kind: "server", note: "waited on GitHub CLI" },
      ],
    };
    useStore.setState({ places: [here, { ...laptop, present: true, name: "spoo", provision }] });
    await mountComputers(computersApi({ agentsRead: async () => ({ ...EMPTY_REPORT, refused: [] }) }).api, { kind: "computer", id: "p_1" });
    expect(document.querySelector("[data-settings-card='recipe']")).toBeNull();
    expect([...document.querySelectorAll("[data-agents-refused] [data-refused-line]")].map(l => [l.querySelector("[data-refused-label]")?.textContent, l.querySelector("[data-refused-value]")?.textContent])).toEqual([
      ["Codex", "failed: npm exited 1"],
      ["linear", "set aside: waited on GitHub CLI"],
    ]);
  });

  it("draws a cloud's agents off its image, with Edit image in Add's place, which opens the recipe in the Image card on the same page", async () => {
    const image = { name: "default", version: 1, hash: "a".repeat(64), recipeHash: "r", pins: [{ id: "claude", tag: "2.1.280" }], logins: [], sealedAt: AT, sealedFrom: "this Mac" } as SealedImage;
    useStore.setState({ places: [here, { ...solari, buildsImages: true }] });
    await mountComputers(computersApi({ image: async () => ({ image, copies: [], projects: [] }), initStart: async () => ({}) as InitJob }, setupOf({ keys: { solari: true } })).api, { kind: "computer", id: "solari" });
    expect(agentTitles()).toEqual(["Claude Code"]);
    expect(screen.queryByRole("button", { name: "Read again" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /^Skills/ }));
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=agents-add]")!);
    await settle();
    expect(pageAt()).toBe("computer:solari");
    expect(document.querySelector("[data-settings-card='image'] [data-k='recipe']")).not.toBeNull();
  });

  it("says how a copy is made there and what it has for a network as rows, off the row and off the landing's own flags", async () => {
    const project = { id: "pr_box", name: "spoo", computer: "p_1", source: { kind: "folder", path: "/root/spoo" }, path: "/root/spoo", createdAt: AT } as never;
    const mac = { id: "pr_here", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/dev/wsp" }, path: "/Users/dev/wsp", createdAt: AT } as never;
    useStore.setState({
      places: [here, { ...laptop, present: true, copies: "reflink" }],
      projects: [mac, project],
      landings: {
        pr_here: { name: "here", capabilities: { copies: true, ownNetwork: false } as never },
        pr_box: { place: "p_1", name: "old-macbook", capabilities: { copies: true, ownNetwork: true } as never },
      },
    });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    expect(wordOf("copies")).toBe("reflink");
    expect(wordOf("ports")).toBe("own network");
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "here" }));
    await settle();
    expect(wordOf("ports")).toBe("shares this Mac's ports");
    expect(rowOf("copies")).toBeNull();
  });

  it("says a computer that copies nothing does, rather than leaving the row out", async () => {
    useStore.setState({ places: [here, { ...laptop, present: true, takesForks: false }] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    expect(wordOf("copies")).toBe(WHERE_WORDS.copiesNothing);
  });

  it("puts this wsp's daemon and the recipe on a computer from Update, holds it at its word while it runs, and reads the job in the list's slot", async () => {
    const asked: string[] = [];
    let answer: (() => void) | undefined;
    const provision: PlaceProvision = { state: "running", addId: "a_2", recipeAt: AT, startedAt: AT, rows: [], at: { label: "uv", index: 3, of: 7 } };
    const api = computersApi({
      placesUpdate: (placeId: string) => {
        asked.push(placeId);
        return new Promise(ok => (answer = () => ok({ name: "old-macbook", provision })));
      },
    } as unknown as Partial<Api>).api;
    useStore.setState({ places: [here, { ...laptop, present: true }] });
    await mountComputers(api, { kind: "computer", id: "p_1" });
    const update = (): Element => document.querySelector("[data-settings-page] [data-k='update']")!;
    expect(rowOf("update")?.querySelector("[data-settings-title]")?.textContent).toBe("Update wsp on old-macbook");
    expect(descriptionOf("update")).toBe(WHERE_WORDS.updateDescription);
    fireEvent.click(update());
    await waitFor(() => expect(asked).toEqual(["p_1"]));
    await waitFor(() => expect(update().hasAttribute("disabled")).toBe(true));
    expect(update().textContent).toBe(WHERE_WORDS.update);
    await act(async () => {
      answer?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(update().hasAttribute("disabled")).toBe(false));
    expect(useStore.getState().places.find(place => place.id === "p_1")?.provision).toEqual(provision);
    act(() => useSettingsStore.getState().go({ kind: "group", group: "computers" }));
    await settle();
    expect(stateOf("p_1")).toBe("setting up 3/7: uv");
  });

  it("holds Update with no title on a wsp whose client cannot ask for one, and the description ends with why", async () => {
    useStore.setState({ places: [here, { ...laptop, present: true }] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    const update = document.querySelector("[data-settings-page] [data-k='update']")!;
    expect(update.hasAttribute("disabled")).toBe(true);
    expect(update.hasAttribute("title")).toBe(false);
    expect(descriptionOf("update")).toBe(`${WHERE_WORDS.updateDescription} ${WHERE_WORDS.updateHeld}`);
  });

  /** A client that can dial, so a button drawn beside a row is held for the row's own reason and never the app's. */
  const dialling = (line = "vps answered in 12 ms."): Partial<Api> =>
    ({ dialPlace: async (placeId: string) => ({ dialled: { at: "2026-09-12T12:00:00.000Z", answered: true, roundTripMs: 12 }, line, place: { ...laptop, id: placeId } }) }) as Partial<Api>;

  it("says a computer that never answered so, reads a computer that is answering plain, and says nothing about reaching a cloud", async () => {
    const fresh: PlaceView = { ...laptop, id: "p_4", name: "vps", lastSeenAt: undefined };
    const alive: PlaceView = { ...laptop, id: "p_5", name: "vps2", present: true, lastSeenAt: "2026-09-12T11:59:00.000Z" };
    useStore.setState({ places: [here, fresh, alive, ascii] });
    await mountComputers(computersApi({}, setupOf({ keys: { box: true } })).api, { kind: "computer", id: "p_4" });
    expect(wordOf("answered")).toBe("not since it joined");
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "p_5" }));
    await settle();
    expect(lineValue("system")).toBe("Ubuntu 24.04");
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "box" }));
    await settle();
    // A cloud's machines are at the other end of a key: no address, nothing that last answered, no dial, no agents.
    for (const k of ["answered", "address", "dial", "agent"]) expect(document.querySelector(`[data-settings-page] [data-k='${k}']`)).toBeNull();
    expect(document.querySelector("[data-settings-card='agents']")).toBeNull();
  });

  it("keeps the last refusal in the Answered row's description and replaces it with what a press of Try now got, one line whole on hover", async () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: false, said } };
    const line = "root@65.21.4.12 answered over ssh in 412 ms, so the computer is on; the agent on it is not dialling this host.";
    useStore.setState({ places: [here, vps] });
    await mountComputers(computersApi(dialling(line)).api, { kind: "computer", id: "p_3" });
    expect(descriptionOf("answered")).toBe(said);
    expect(document.querySelector("[data-k='dial']")?.textContent).toBe("Try over ssh");
    fireEvent.click(document.querySelector("[data-k='dial']")!);
    await waitFor(() => expect(descriptionOf("answered")).toBe(line));
    expect(rowOf("answered")?.querySelector("[data-settings-description]")?.getAttribute("title")).toBe(line);
    expect(rowOf("answered")?.querySelector("[data-settings-description]")?.className).toContain("truncate");
  });

  it("draws a refused Try now in the refusal slot with the host's fix, and leaves the Answered row's description as it was", async () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: false, said } };
    useStore.setState({ places: [here, vps] });
    const refused = { dialPlace: async () => Promise.reject(new RequestError("wsp holds no login for vps. Add it again over ssh.", undefined, "Add it again over ssh.")) } as unknown as Partial<Api>;
    await mountComputers(computersApi(refused).api, { kind: "computer", id: "p_3" });
    fireEvent.click(document.querySelector("[data-k='dial']")!);
    const slot = await waitFor(() => {
      const found = document.querySelector("[data-settings-page] [data-k='dial-refusal']");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(slot.textContent).toBe("wsp holds no login for vps. Add it again over ssh.");
    expect(slot.querySelector("span.text-foreground")?.textContent?.trim()).toBe("Add it again over ssh.");
    expect(descriptionOf("answered")).toBe(said);
  });

  it("offers no dial where there is no road to dial over, says why in the description, and words the button for the road there is", async () => {
    const said = placeNoDialLine("old-macbook");
    const byCode: PlaceView = { ...laptop, road: { from: "192.168.1.34" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: false, said } };
    const linked: PlaceView = { ...laptop, id: "p_6", name: "linked", present: true };
    useStore.setState({ places: [here, byCode, linked] });
    await mountComputers(computersApi(dialling()).api, { kind: "computer", id: "p_1" });
    expect(descriptionOf("answered")).toBe(said);
    expect(document.querySelector("[data-k='dial']")).toBeNull();
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "p_6" }));
    await settle();
    expect(document.querySelector("[data-k='dial']")?.textContent).toBe("Try now");
  });

  it("says in the description that this wsp cannot dial, and draws no button, where the client has no dial road", async () => {
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" } };
    useStore.setState({ places: [here, vps] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_3" });
    expect(descriptionOf("answered")).toBe(WHERE_WORDS.cannotDial);
    expect(document.querySelector("[data-k='dial']")).toBeNull();
  });

  it("computes the Remove sentence from what that computer holds, hands an offline one the line to run by hand, and takes it out on the host's own road", async () => {
    const removed: string[] = [];
    withWorkspaces();
    await mountComputers(computersApi({ removePlace: async (id: string) => (removed.push(id), { removed: true, swept: [] }) } as unknown as Partial<Api>).api, { kind: "computer", id: "p_1" });
    expect(rowOf("remove")?.querySelector("[data-settings-title]")?.textContent).toBe("Remove old-macbook");
    expect(descriptionOf("remove")).toBe(WHERE_WORDS.removeDescription("old-macbook"));
    fireEvent.click(document.querySelector("[data-settings-page] [data-k='remove']")!);
    expect(screen.getByText("Remove old-macbook?")).toBeTruthy();
    expect(document.querySelector("[data-k='remove-sentence']")?.textContent).toBe("wsp and its task come off old-macbook, which is otherwise left as it is, and the copy of your image stays where it is. The task's record and 2 threads leave this Mac. It is offline; what is on it is swept the next time it connects.");
    expect(document.querySelector("[data-k='leave-line']")?.textContent).toBe(PLACES_WORDS.remove.leaveLine);
    expect(document.querySelector("[data-remove-place-dialog]")?.textContent).toContain(imageCopyStaysLine());
    fireEvent.click(document.querySelector("[data-k='remove-confirm']")!);
    await waitFor(() => expect(removed).toEqual(["p_1"]));
    // The page that was about the removed computer goes back to the list.
    await waitFor(() => expect(pageAt()).toBe("computers"));
  });

  it("draws a refused remove in the refusal slot, the host's fix in the fix ink, and a remove the host did not make in that same slot", async () => {
    useStore.setState({ places: [here, { ...laptop, present: true }] });
    let answer: () => Promise<unknown> = async () => Promise.reject(new RequestError("old-macbook still holds a running workspace. Stop it first, then remove again.", undefined, "Stop it first, then remove again."));
    await mountComputers(computersApi({ removePlace: async () => answer() } as unknown as Partial<Api>).api, { kind: "computer", id: "p_1" });
    fireEvent.click(document.querySelector("[data-settings-page] [data-k='remove']")!);
    fireEvent.click(document.querySelector("[data-k='remove-confirm']")!);
    const slot = await waitFor(() => {
      const found = document.querySelector("[data-k='remove-refusal']");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(slot.textContent).toBe("old-macbook still holds a running workspace. Stop it first, then remove again.");
    expect(slot.className).toContain("text-destructive-foreground");
    expect(slot.querySelector("span.text-foreground")?.textContent?.trim()).toBe("Stop it first, then remove again.");
    answer = async () => ({ removed: false, swept: [], note: "old-macbook was not removed: its record is locked" });
    fireEvent.click(document.querySelector("[data-k='remove-confirm']")!);
    await waitFor(() => expect(document.querySelector("[data-k='remove-refusal']")?.textContent).toBe("old-macbook was not removed: its record is locked"));
    expect(document.querySelector("[data-k='remove-refusal'] span.text-foreground")).toBeNull();
  });

  it("gives a computer that is answering no line to run by hand: the host sweeps it over the link", async () => {
    useStore.setState({ places: [here, { ...laptop, present: true }] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    fireEvent.click(document.querySelector("[data-settings-page] [data-k='remove']")!);
    expect(screen.getByText("Remove old-macbook?")).toBeTruthy();
    expect(document.querySelector("[data-k='leave-line']")).toBeNull();
  });
});

describe("a computer's icon", () => {
  it("reads the default off what the computer is, writes a pick as that computer's look, and the row draws the pick", async () => {
    useStore.setState({ places: [here, box], workspaces: [] });
    const { api, sets } = computersApi();
    await mountComputers(api, { kind: "computer", id: "p_2" });
    const select = document.querySelector<HTMLElement>("[data-settings-page] [data-k=computer-icon]")!;
    expect(select.textContent).toBe("Server");
    await pickOption(select, "Home");
    await waitFor(() => expect(sets).toEqual([{ computerLook: { p_2: { icon: "home" } } }]));
    cleanup();
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false, computerLook: { p_2: { icon: "home" } } } });
    await mountComputers(computersApi().api);
    expect(listRow("p_2").querySelector("[data-computer-glyph]")?.classList.contains("lucide-house")).toBe(true);
    expect(listRow("here").querySelector("[data-computer-glyph]")?.classList.contains("lucide-monitor")).toBe(true);
  });
});

describe("the cloud's page", () => {
  const HASH = "a".repeat(63) + "1";
  const IMAGE: SealedImage = {
    name: "default",
    version: 2,
    hash: HASH,
    recipeHash: "recipe-1",
    logins: [{ name: "claude", state: "copied" }, { name: "gh", state: "signed-in" }],
    sealedAt: "2026-09-12T09:12:00.000Z",
    sealedFrom: "this Mac",
    vault: { sha256: "c".repeat(64), bytes: 4_200, paths: 7, takenAt: AT },
    usedBytes: 4.2 * 1024 ** 3,
  };
  const copy = { place: "hetzner", version: 1, hash: HASH, snapshotId: "snap_h", builtAt: "2026-09-12T10:00:00.000Z", sizeBytes: 4.2 * 1024 ** 3 };

  it("carries the spend as a line, the Image card with what the image holds and Edit in it, the copies as lines and Remove saying the key is forgotten, while the key is held", async () => {
    const api = computersApi(
      { image: async () => ({ image: IMAGE, copies: [copy], projects: [] }), spend: async () => [{ place: "solari", monthUsd: 4.12, rateUsdPerHour: 0.16 }], initStart: async () => ({}) as InitJob } as Partial<Api>,
      setupOf({ keys: { solari: true } }),
    ).api;
    useStore.setState({ places: [here, { ...solari, buildsImages: true }], workspaces: [atSolari("ws_y"), atSolari("ws_z")] });
    await mountComputers(api, { kind: "computer", id: "solari" });
    // The rate is what is running there, so the count of workspaces it is spread over is not said again: the
    // clause wrapped the value onto a second line at a phone's width to add nothing.
    expect(lineValue("spend")).toBe("$4.12 this month $0.16/hr");
    expect([...document.querySelectorAll("[data-settings-page] [data-settings-card]")].map(card => card.getAttribute("data-settings-card"))).toEqual(["cloud", "image", "agents", "copies", "acts"]);
    expect(document.querySelector("[data-k='image-state']")?.getAttribute("data-state")).toBe("none");
    expect(document.querySelector("[data-k='edit-recipe']")?.textContent).toBe(IMAGE_WORDS.holdsEdit);
    expect([...document.querySelectorAll("[data-k='image-copy']")].map(row => [row.getAttribute("data-place"), row.querySelector("[data-settings-word]")?.textContent])).toEqual([["hetzner", expect.stringMatching(new RegExp(`^v1 \\(${COPY_CURRENT}\\), 4\\.2 GB, `))]]);
    expect(descriptionOf("remove")).toBe(WHERE_WORDS.removeCloudDescription);
    fireEvent.click(document.querySelector("[data-k='edit-recipe']")!);
    await settle();
    // The recipe opens in the card.
    expect(document.querySelector("[data-settings-card='image'] [data-k='recipe']")).not.toBeNull();
  });

  it("says nothing about the image on a cloud whose key this host does not hold, and draws no card with nothing in it", async () => {
    // A cloud row stands on a workspace alone; the image is what this host's own key builds, so a page with no key
    // has no image line, no Edit image and no copies, and the card those would have stood in is not drawn.
    const api = computersApi({ image: async () => ({ image: IMAGE, copies: [copy], projects: [] }) } as Partial<Api>, setupOf({ keys: { solari: false } })).api;
    useStore.setState({ places: [here, { ...solari, buildsImages: true }], workspaces: [atSolari("ws_y")] });
    await mountComputers(api, { kind: "computer", id: "solari" });
    expect(document.querySelector("[data-settings-card='image']")).toBeNull();
    expect(document.querySelector("[data-k='edit-image']")).toBeNull();
    expect(document.querySelector("[data-settings-card='copies']")).toBeNull();
    expect(document.querySelector("[data-settings-card='cloud']")).toBeNull();
    // Its one act stands, and the card that holds it is the only one on the page.
    expect([...document.querySelectorAll("[data-settings-page] [data-settings-card]")].map(card => card.getAttribute("data-settings-card"))).toEqual(["acts"]);
    // Remove is the neutral door, red only under the pointer, and the dialog's own button is the red one.
    const remove = document.querySelector<HTMLElement>("[data-settings-page] [data-k='remove']")!;
    expect(remove.className).not.toMatch(/warning/);
    expect(remove.className).toContain("[:hover,[data-pressed]]:text-destructive-foreground");
    fireEvent.click(remove);
    expect(document.querySelector<HTMLElement>("[data-k='remove-confirm']")!.className).toContain("bg-destructive");
  });

  it("draws the Image card before a build, and no copies card", async () => {
    const api = computersApi({ image: async () => ({ image: null, copies: [], projects: [] }) } as Partial<Api>, setupOf({ keys: { solari: true } })).api;
    useStore.setState({ places: [here, { ...solari, buildsImages: true }] });
    await mountComputers(api, { kind: "computer", id: "solari" });
    expect(document.querySelector("[data-k='image-state']")?.getAttribute("data-state")).toBe("none");
    expect(document.querySelector("[data-settings-card='copies']")).toBeNull();
  });
});

describe("Add a computer on the page", () => {
  const open = async (road: "ssh" | "cloud" | "code" | null, over: Partial<Api> = {}, setup: InitSetup | null = null) => {
    const fake = settingsApi(over);
    useStore.setState({ api: fake.api, places: [here] });
    render(<AddComputer setup={setup} now={() => NOW} />);
    if (road !== null) fireEvent.click(document.querySelector(`[data-add-road='${road}']`)!);
    return fake;
  };
  /** An installer that never answers on its own: the case answers or refuses it, and the steps ride the store's
   * events under the stream the sheet minted, as the host's do. */
  const pending = () => {
    const at: { login?: SshLogin; addId?: string; answer: (p: PlaceView) => void; refuse: (e: Error) => void } = { answer: () => {}, refuse: () => {} };
    const api = {
      addComputerOverSsh: (login: SshLogin, addId: string) =>
        new Promise<PlaceView>((ok, no) => {
          Object.assign(at, { login, addId, answer: ok, refuse: no });
        }),
    } as unknown as Partial<Api>;
    return { at, api };
  };
  const stage = (addId: string, step: PlaceAddStep, state: "running" | "done" | "failed", note?: string): void =>
    act(() => useStore.getState().applyEvent({ type: "place.stage", addId, step, state, ...(note === undefined ? {} : { note }) } as EventUnion));
  const refuseWith = async (at: { refuse: (e: Error) => void }, e: Error): Promise<void> => {
    await act(async () => {
      at.refuse(e);
      await Promise.resolve();
    });
  };
  const host = (): HTMLInputElement => document.querySelector<HTMLInputElement>("[data-k='road-ssh'] [data-k='login']")!;
  const user = (): HTMLInputElement => document.querySelector<HTMLInputElement>("[data-k='ssh-user']")!;
  const slot = (): string => document.querySelector("[data-k='ssh-refusal']")?.textContent ?? "";
  const plan = (): [string | null, string | null][] => [...document.querySelectorAll("[data-k='plan'] li")].map(l => [l.textContent, l.getAttribute("data-state")]);
  const job = (over: Partial<PlaceAddJob>): PlaceAddJob => ({ addId: "a_host", address: "root@spoo", startedAt: "2026-09-12T11:59:00.000Z", state: "running", steps: [], ...over });

  it("offers the three roads as pictures with none picked, and draws no flow until one is", async () => {
    await open(null);
    const roads = [...document.querySelectorAll("[data-add-road]")];
    expect(roads.map(r => r.getAttribute("data-add-road"))).toEqual(["ssh", "cloud", "code"]);
    expect(roads.every(r => r.getAttribute("aria-checked") === "false")).toBe(true);
    expect(document.querySelector("[data-k^='road-']")).toBeNull();
  });

  it("asks for user, host and port over ssh, focuses the host, and lists what happens before Add", async () => {
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    expect(document.activeElement).toBe(host());
    expect(document.querySelectorAll("[data-k='road-ssh'] input")).toHaveLength(3);
    expect(plan()).toHaveLength(PlaceAddStep.options.length);
    expect(plan().every(([, state]) => state === "waiting")).toBe(true);
    expect(document.querySelector("[data-k='road-ssh'] header")?.textContent).toBe(document.querySelector("[data-add-road='ssh'] span.text-\\[13px\\]")?.textContent);
  });

  it("holds Add until a host is typed, and on a wsp whose host cannot log in over ssh at all", async () => {
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    const add = (): Element => document.querySelector("[data-k='ssh-add']")!;
    expect(add().hasAttribute("data-held")).toBe(true);
    fireEvent.change(host(), { target: { value: "65.21.4.12" } });
    expect(add().hasAttribute("data-held")).toBe(false);
    cleanup();
    await open("ssh");
    fireEvent.change(host(), { target: { value: "65.21.4.12" } });
    expect(document.querySelector("[data-k='ssh-add']")?.hasAttribute("data-held")).toBe(true);
    expect(slot()).toBe(ADD_COMPUTER_WORDS.noRoad);
  });

  it("sends user@host and a port other than 22, and fills the lines in as the host's steps arrive", async () => {
    const { at, api } = pending();
    await open("ssh", api);
    fireEvent.change(user(), { target: { value: "root" } });
    fireEvent.change(host(), { target: { value: "65.21.4.12" } });
    fireEvent.change(document.querySelector("[data-k='ssh-port']")!, { target: { value: "2222" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(host().disabled).toBe(true));
    expect(at.login).toEqual({ address: "root@65.21.4.12", port: 2222 });
    stage(at.addId!, "connect", "done", "Ubuntu 24.04");
    stage(at.addId!, "wsp", "running", "x86_64");
    expect(plan()[0]).toEqual([`${placeAddSheetWord("connect", "done")}Ubuntu 24.04`, "done"]);
    const wsp = PlaceAddStep.options.indexOf("wsp");
    expect(plan()[wsp]).toEqual([`${wsp + 1}${placeAddSheetWord("wsp", "running")}x86_64`, "running"]);
    // A stream this sheet did not mint is not its own.
    stage("a_else", "reach", "done");
    expect(plan()[PlaceAddStep.options.indexOf("reach")]![1]).toBe("waiting");
  });

  it("shows the spinner inside the Adding button while an add runs, and not before or after", async () => {
    const { at, api } = pending();
    await open("ssh", api);
    const spinner = (): Element | null => document.querySelector("[data-k='ssh-add'] [data-k='adding-spinner']");
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    expect(spinner()).toBeNull();
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(spinner()).not.toBeNull());
    expect(document.querySelector("[data-k='ssh-add']")?.textContent).toBe(ADD_COMPUTER_WORDS.adding);
    await refuseWith(at, new RequestError("root@65.21.4.12 did not answer on port 22"));
    expect(spinner()).toBeNull();
  });

  it("on a failed add keeps the finished steps ticked, marks the step the host failed, and leaves the rest waiting", async () => {
    const { at, api } = pending();
    await open("ssh", api);
    fireEvent.change(host(), { target: { value: "root@spoo" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    stage(at.addId!, "connect", "done");
    stage(at.addId!, "host-key", "done");
    stage(at.addId!, "reach", "running");
    stage(at.addId!, "reach", "failed", "spoo cannot reach this computer at any of its addresses");
    await refuseWith(at, new RequestError("spoo cannot reach this computer at any of its addresses"));
    const states = plan().map(([, state]) => state);
    expect(states).toEqual(["done", "done", "failed", ...PlaceAddStep.options.slice(3).map(() => "waiting")]);
    const failed = document.querySelector("[data-k='plan'] li[data-state='failed']")!;
    expect(failed.querySelector("[data-k='step-failed']")?.className).toContain("destructive");
    expect(document.querySelectorAll("[data-k='plan'] li[data-state='done'] svg")).toHaveLength(2);
    expect(host().disabled).toBe(false);
  });

  it("marks the first step failed when the add is refused before the host kept any step", async () => {
    const { at, api } = pending();
    await open("ssh", api);
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await refuseWith(at, new RequestError("wsp add refuses a loopback address"));
    expect(plan().map(([, state]) => state)).toEqual(["failed", ...PlaceAddStep.options.slice(1).map(() => "waiting")]);
    expect(slot()).toBe("wsp add refuses a loopback address");
  });

  it("draws an add the host is running when the page opens after a reload: its address in the fields, its steps, Add held", async () => {
    useAdds.setState({ jobs: { a_host: job({ address: "maya@spoo", sshPort: 2222, steps: [{ step: "connect", state: "done", note: "Debian 12" }, { step: "wsp", state: "running" }] }) } });
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    expect(user().value).toBe("maya");
    expect(host().value).toBe("spoo");
    expect(document.querySelector<HTMLInputElement>("[data-k='ssh-port']")!.value).toBe("2222");
    expect(plan()[0]).toEqual([`${placeAddSheetWord("connect", "done")}Debian 12`, "done"]);
    expect(plan()[PlaceAddStep.options.indexOf("wsp")]![1]).toBe("running");
    expect(document.querySelector("[data-k='ssh-add'] [data-k='adding-spinner']")).not.toBeNull();
    expect(host().disabled).toBe(true);
  });

  it("draws the refusal the host kept, in its two halves, when the page opens after the add failed", async () => {
    useAdds.setState({ jobs: { a_host: job({ state: "failed", steps: [{ step: "connect", state: "done" }, { step: "wsp", state: "failed", note: "spoo has no curl" }], said: "spoo has no curl or wget on its PATH.", fix: "Install one of them there, then add again." }) } });
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    const refusal = document.querySelector("[data-k='ssh-refusal']")!;
    expect(refusal.textContent).toBe("spoo has no curl or wget on its PATH. Install one of them there, then add again.");
    expect(refusal.querySelector("span.text-foreground")?.textContent?.trim()).toBe("Install one of them there, then add again.");
    expect(plan()[PlaceAddStep.options.indexOf("wsp")]![1]).toBe("failed");
    expect(host().value).toBe("spoo");
  });

  it("draws the add asked here over one the host kept, whatever the two clocks stamped them", async () => {
    useAdds.setState({ jobs: { a_host: job({ state: "failed", startedAt: "2099-01-01T00:00:00.000Z", said: "an old refusal" }) } });
    const { at, api } = pending();
    await open("ssh", api);
    expect(slot()).toBe("an old refusal");
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(host().disabled).toBe(true));
    stage(at.addId!, "connect", "done");
    expect(slot()).toBe("");
    expect(plan()[0]![1]).toBe("done");
  });

  it("gives the login fix to a login the host refused, and to nothing else", async () => {
    useAdds.setState({ jobs: { a_host: job({ state: "failed", steps: [{ step: "connect", state: "failed" }], said: "maya@spoo: Permission denied (publickey).", kind: PLACE_LOGIN_REFUSED_KIND }) } });
    await open("ssh");
    expect(slot()).toBe(`maya@spoo: Permission denied (publickey). ${ADD_COMPUTER_WORDS.refusedFix}`);
    cleanup();
    useAdds.setState({ jobs: { a_host: job({ state: "failed", steps: [{ step: "connect", state: "failed" }], said: "root@spoo runs zsh as root's shell" }) } });
    await open("ssh");
    expect(slot()).toBe("root@spoo runs zsh as root's shell");
  });

  it("clears a refusal the moment the person changes what they typed", async () => {
    useAdds.setState({ jobs: { a_host: job({ state: "failed", steps: [{ step: "connect", state: "failed" }], said: "root@spoo did not answer on port 22" }) } });
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    expect(slot()).toBe("root@spoo did not answer on port 22");
    expect(host().getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(document.querySelector("[data-k='ssh-port']")!, { target: { value: "2222" } });
    expect(slot()).toBe("");
    expect(host().hasAttribute("aria-invalid")).toBe(false);
    expect(host().value).toBe("spoo");
  });

  it("keeps what was typed and not sent in this window when the person leaves the page, and through another window's add, and never sends it", async () => {
    const asked: SshLogin[] = [];
    await open("ssh", { addComputerOverSsh: async (login: SshLogin) => (asked.push(login), box) } as unknown as Partial<Api>);
    fireEvent.change(user(), { target: { value: "maya" } });
    fireEvent.change(host(), { target: { value: "hetzner" } });
    fireEvent.change(document.querySelector("[data-k='ssh-port']")!, { target: { value: "2200" } });
    cleanup();
    render(<AddComputer setup={null} now={() => NOW} />);
    fireEvent.click(document.querySelector("[data-add-road='ssh']")!);
    expect([user().value, host().value, document.querySelector<HTMLInputElement>("[data-k='ssh-port']")!.value]).toEqual(["maya", "hetzner", "2200"]);
    // Another window's add takes the form while it runs, and hands it back as it ends.
    act(() => useAdds.setState(s => ({ jobs: { ...s.jobs, a_other: job({ addId: "a_other", address: "root@elsewhere" }) } })));
    stage("a_other", "connect", "running");
    expect([host().value, host().disabled]).toEqual(["elsewhere", true]);
    stage("a_other", "connect", "failed", "root@elsewhere did not answer on port 22");
    expect([user().value, host().value, document.querySelector<HTMLInputElement>("[data-k='ssh-port']")!.value]).toEqual(["maya", "hetzner", "2200"]);
    expect(asked).toEqual([]);
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await settle();
    expect(asked).toEqual([{ address: "maya@hetzner", port: 2200 }]);
    expect(useAdds.getState().draft).toBeNull();
  });

  it("keeps the run when the person switches roads or leaves the page and comes back, since the host keeps installing", async () => {
    const { at, api } = pending();
    await open("ssh", api);
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    stage(at.addId!, "connect", "done", "Ubuntu 24.04");
    fireEvent.click(document.querySelector("[data-add-road='cloud']")!);
    expect(document.querySelector("[data-k='road-ssh']")).toBeNull();
    fireEvent.click(document.querySelector("[data-add-road='ssh']")!);
    expect(user().value).toBe("root");
    expect(host().value).toBe("65.21.4.12");
    expect(plan()[0]![1]).toBe("done");
    cleanup();
    render(<AddComputer setup={null} now={() => NOW} />);
    fireEvent.click(document.querySelector("[data-add-road='ssh']")!);
    await refuseWith(at, new RequestError("root@65.21.4.12 did not answer on port 22"));
    expect(slot()).toBe("root@65.21.4.12 did not answer on port 22");
  });

  it("reads the box as joined once the host says it joined, drawing its computer row, and Add another clears it", async () => {
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    useStore.setState({ places: [here, box] });
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(document.querySelector("[data-k='joined'] [data-place-row='p_2']")).toBeTruthy());
    expect(document.querySelector("[data-k='joined'] [data-settings-title]")?.textContent).toBe("hetzner");
    fireEvent.click(screen.getByRole("button", { name: ADD_COMPUTER_WORDS.another }));
    expect(document.querySelector("[data-k='joined']")).toBeNull();
    expect(host().value).toBe("");
  });

  it("runs the whole road on the client this app builds: Add sends places.add and the stages that ride it draw", async () => {
    ScriptedSocket.instances.length = 0;
    ScriptedSocket.reply = (f: Frame) => (f["op"] === "places.add" || f["op"] === "places.sshHosts" ? undefined : { id: f["id"], ok: true });
    const client = (live = new ProtocolClient({ url: "ws://test", token: "tok", WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket }));
    await client.connect();
    const sock = ScriptedSocket.instances[0]!;
    const api = makeApi(client);
    api.subscribe(e => useStore.getState().applyEvent(e));
    useStore.setState({ api, places: [here] });
    render(<AddComputer setup={null} now={() => NOW} />);
    fireEvent.click(document.querySelector("[data-add-road='ssh']")!);
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    fireEvent.keyDown(host(), { key: "Enter" });
    await waitFor(() => expect(sock.frames("places.add").length).toBe(1));
    const asked = sock.frames("places.add")[0]!;
    expect(asked).toMatchObject({ address: "root@65.21.4.12", addId: expect.any(String) });
    const addId = String(asked["addId"]);
    await act(async () => {
      sock.onmessage?.({ data: JSON.stringify({ type: "place.stage", addId, step: "connect", state: "done", note: "Ubuntu 24.04" }) });
      await Promise.resolve();
    });
    expect(plan()[0]![1]).toBe("done");
    await act(async () => {
      sock.onmessage?.({ data: JSON.stringify({ type: "place.joined", place: box, from: "65.21.4.12" }) });
      sock.onmessage?.({ data: JSON.stringify({ type: "place.stage", addId, step: "join", state: "done", placeId: "p_2" }) });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector("[data-k='joined']")?.textContent).toContain("hetzner"));
  });

  it("carries the host's fix off the wire into the slot, and the login fix off the refusal's own kind", async () => {
    ScriptedSocket.instances.length = 0;
    ScriptedSocket.reply = (f: Frame) => (f["op"] === "places.add" || f["op"] === "places.sshHosts" ? undefined : { id: f["id"], ok: true });
    const client = (live = new ProtocolClient({ url: "ws://test", token: "tok", WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket }));
    await client.connect();
    const sock = ScriptedSocket.instances[0]!;
    useStore.setState({ api: makeApi(client), places: [here] });
    render(<AddComputer setup={null} now={() => NOW} />);
    fireEvent.click(document.querySelector("[data-add-road='ssh']")!);
    const refuse = async (reply: Record<string, unknown>): Promise<string> => {
      const before = sock.frames("places.add").length;
      fireEvent.change(host(), { target: { value: "spoo" } });
      fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
      await waitFor(() => expect(sock.frames("places.add").length).toBe(before + 1));
      const asked = sock.frames("places.add").at(-1)!;
      await act(async () => {
        sock.onmessage?.({ data: JSON.stringify({ id: asked["id"], ok: false, ...reply }) });
        await Promise.resolve();
      });
      await waitFor(() => expect(slot()).not.toBe(""));
      return slot();
    };
    expect(await refuse({ error: "spoo is neither a login like root@host nor an alias your ssh config gives a HostName", kind: PLACE_LOGIN_REFUSED_KIND })).toContain(ADD_COMPUTER_WORDS.refusedFix);
    expect(await refuse({ error: "wsp add refuses a loopback address" })).toBe("wsp add refuses a loopback address");
    expect(await refuse({ error: "spoo has no curl or wget on its PATH. Install one of them there, then add again.", fix: "Install one of them there, then add again." })).toBe("spoo has no curl or wget on its PATH. Install one of them there, then add again.");
    expect(document.querySelector("[data-k='ssh-refusal'] span.text-foreground")?.textContent?.trim()).toBe("Install one of them there, then add again.");
  });

  // Each is thrown with the connect step still running, as the host throws them: the login stood and the box said no.
  it.each([
    ["the box already in another wsp", "root@spoo already belongs to the wsp on studio at http://10.0.0.2:4640; wsp leave on it frees it"],
    ["root's shell", "root@spoo runs zsh as root's shell, and wsp runs only under bash or sh there"],
    ["the chip", "root@spoo runs on riscv64, and wsp builds no daemon for that chip"],
    ["the host key mismatch", "root@spoo answered with a key other than the one you pinned"],
  ])("says a refusal after the login stood (%s) with no login fix", async (_what, sentence) => {
    const { at, api } = pending();
    await open("ssh", api);
    fireEvent.change(host(), { target: { value: "root@spoo" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    stage(at.addId!, "connect", "running");
    stage(at.addId!, "host-key", "done");
    stage(at.addId!, "connect", "failed", sentence);
    await refuseWith(at, new RequestError(sentence));
    expect(slot()).toBe(sentence);
  });

  it("says a box that took wsp and did not connect back in the box's one sentence, with no ssh login fix and no script", async () => {
    const { at, api } = pending();
    await open("ssh", api);
    fireEvent.change(host(), { target: { value: "root@178.156.161.168" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    const sentence = "spoo took wsp but could not connect back: the host at http://100.129.166.28:4640 did not answer in 20s";
    stage(at.addId!, "connect", "done", "Ubuntu 24.04");
    stage(at.addId!, "wsp", "done");
    stage(at.addId!, "service", "running");
    await refuseWith(at, new Error(sentence));
    // The login stood and the bytes landed, so a fix about the user, the address or a key would send them the wrong way.
    expect(slot()).toBe(sentence);
    expect(slot()).not.toContain('case "$(uname -m)"');
  });

  it("lists every provider with its own key field, saves each on its own, and says key saved once the host lists that cloud", async () => {
    const asked: { provider?: string; key?: string }[] = [];
    let places: PlaceView[] = [here];
    await open(
      "cloud",
      {
        initKeys: async (k: { provider?: string; key?: string }) => {
          asked.push(k);
          places = [here, ascii];
          return setupOf({ keys: { solari: false, box: k.provider === "box" } });
        },
        placesList: async () => ({ places, adds: [] }),
      } as unknown as Partial<Api>,
      setupOf({ keys: { solari: false, box: false } }),
    );
    const blocks = [...document.querySelectorAll("[data-k='road-cloud'] [data-provider]")];
    expect(blocks.map(b => b.getAttribute("data-provider"))).toEqual(["box", "solari"]);
    // Each provider by the name the protocol gives it, and the picker's line names the same ones.
    expect(blocks.map(b => b.querySelector("span.text-\\[14px\\]")?.textContent)).toEqual([PROVIDER_KEY_WORDS["box"]!.name, PROVIDER_KEY_WORDS["solari"]!.name]);
    expect(document.querySelector("[data-add-road='cloud']")?.textContent).toContain(`${PROVIDER_KEY_WORDS["box"]!.name} or ${PROVIDER_KEY_WORDS["solari"]!.name}`);
    expect(document.body.textContent).not.toContain("no key");
    const boxKey = blocks[0]!;
    fireEvent.change(boxKey.querySelector("[data-k='cloud-key']")!, { target: { value: "k-123" } });
    fireEvent.click(boxKey.querySelector("[data-k='cloud-save']")!);
    await waitFor(() => expect(boxKey.querySelector("[data-k='key-state']")?.textContent).toBe(ADD_COMPUTER_WORDS.keySaved));
    expect(asked).toEqual([{ provider: "box", key: "k-123" }]);
    expect(blocks[1]!.querySelector("[data-k='key-state']")).toBeNull();
  });

  it("says a key the host kept with no cloud row as kept and no computer yet, never as saved", async () => {
    await open(
      "cloud",
      { initKeys: async () => setupOf({ keys: { solari: false, box: true } }), placesList: async () => ({ places: [here], adds: [] }) } as unknown as Partial<Api>,
      setupOf({ keys: { solari: false, box: false } }),
    );
    const boxKey = document.querySelector("[data-k='road-cloud'] [data-provider='box']")!;
    fireEvent.change(boxKey.querySelector("[data-k='cloud-key']")!, { target: { value: "k-123" } });
    fireEvent.click(boxKey.querySelector("[data-k='cloud-save']")!);
    await waitFor(() => expect(boxKey.querySelector("[data-k='key-state']")?.textContent).toBe(ADD_COMPUTER_WORDS.keyKept));
    await settle();
    expect(boxKey.querySelector("[data-k='key-state']")?.textContent).toBe(ADD_COMPUTER_WORDS.keyKept);
  });

  it("says a key the host did not take as that cloud refusing it, with where to check it, and a refused save in the host's two halves", async () => {
    let refuse: Error | undefined;
    await open(
      "cloud",
      { initKeys: async () => (refuse !== undefined ? Promise.reject(refuse) : setupOf({ keys: { solari: false, box: false } })), placesList: async () => ({ places: [here], adds: [] }) } as unknown as Partial<Api>,
      setupOf({ keys: { solari: false, box: false } }),
    );
    const boxKey = document.querySelector("[data-k='road-cloud'] [data-provider='box']")!;
    const save = async (): Promise<string> => {
      fireEvent.change(boxKey.querySelector("[data-k='cloud-key']")!, { target: { value: "k-123" } });
      fireEvent.click(boxKey.querySelector("[data-k='cloud-save']")!);
      await settle();
      return boxKey.querySelector("[data-k='cloud-refusal']")?.textContent ?? "";
    };
    const words = ADD_COMPUTER_WORDS.keyRefused(PROVIDER_KEY_WORDS["box"]!);
    expect(await save()).toBe(`${words.said} ${words.fix}`);
    expect(words.said).toBe(`${PROVIDER_KEY_WORDS["box"]!.name} refused that key.`);
    expect(words.fix).toBe(`Check it at ${PROVIDER_KEY_WORDS["box"]!.keyConsole} and paste it again.`);
    expect(boxKey.querySelector("[data-k='key-state']")).toBeNull();
    refuse = new RequestError("Box refused. Check it and paste it again.", "auth", "Check it and paste it again.");
    expect(await save()).toBe("Box refused. Check it and paste it again.");
    expect(boxKey.querySelector("[data-k='cloud-refusal'] span.text-foreground")?.textContent?.trim()).toBe("Check it and paste it again.");
  });

  it("draws the ssh hosts the host suggests as it answered them, and asks again once the computers change", async () => {
    let asked = 0;
    await open("ssh", { addComputerOverSsh: async () => box, sshHosts: async () => (asked++, [{ alias: "hetzner", hostName: "65.21.4.12", from: "config" }]) } as unknown as Partial<Api>);
    useStore.setState({ places: [here, box] });
    await waitFor(() => expect(asked).toBe(2));
    // The host is the one that leaves out the computers already added; a row it names stands, even under a computer's name.
    await waitFor(() => expect([...document.querySelectorAll("[data-ssh-host]")].map(b => b.getAttribute("data-ssh-host"))).toEqual(["hetzner"]));
  });

  it("says the ssh config was not read where its hosts would be, and says nothing for a socket that may not ask", async () => {
    await open("ssh", { addComputerOverSsh: async () => box, sshHosts: async () => Promise.reject(new RequestError("~/.ssh/config: permission denied", undefined, undefined)) } as unknown as Partial<Api>);
    await settle();
    expect(document.querySelector("[data-k='ssh-hosts-refused']")?.textContent).toBe(ADD_COMPUTER_WORDS.hostsNotRead("~/.ssh/config: permission denied"));
    expect(document.querySelector("[data-k='ssh-hosts']")).toBeNull();
    cleanup();
    await open("ssh", { addComputerOverSsh: async () => box, sshHosts: async () => Promise.reject(new RequestError(PLACES_TICKET_REFUSAL, "ticket")) } as unknown as Partial<Api>);
    await settle();
    expect(document.querySelector("[data-k='ssh-hosts-refused']")).toBeNull();
  });

  it("mints the join line, counts the code down, and holds New code where this wsp mints none", async () => {
    await open("code", { mintJoin: async () => ({ joins: [{ url: "http://10.0.0.2:4640", line: "wsp join http://10.0.0.2:4640 --code AB12-CD34.fp" }], expiresAt: new Date(NOW + 600_000).toISOString() }) } as unknown as Partial<Api>);
    await waitFor(() => expect(document.querySelector("[data-k='join-line'] code")?.textContent).toBe("wsp join http://10.0.0.2:4640 --code AB12-CD34.fp"));
    expect(document.querySelector("[data-k='code-left']")?.textContent).toBe(ADD_COMPUTER_WORDS.codeLeft(600_000));
    expect(document.querySelector("[data-k='install-line'] code")?.textContent).toBe(PLACES_WORDS.sheet.install);
    cleanup();
    await open("code");
    expect(document.querySelector("[data-k='code-left']")?.textContent).toBe(ADD_COMPUTER_WORDS.noMint);
  });

  it("says not copied beside a line the clipboard refused, for a moment", async () => {
    const write = navigator.clipboard?.writeText;
    Object.assign(navigator, { clipboard: { writeText: () => Promise.reject(new Error("Document is not focused.")) } });
    try {
      await open("code", { mintJoin: async () => ({ joins: [], expiresAt: new Date(NOW + 600_000).toISOString() }) } as unknown as Partial<Api>);
      const line = document.querySelector("[data-k='install-line']")!;
      fireEvent.click(line.querySelector("button")!);
      await waitFor(() => expect(line.querySelector("[data-k='not-copied']")?.textContent).toBe(ADD_COMPUTER_WORDS.notCopied));
      expect(line.querySelector("button")?.getAttribute("aria-label")).toBe(ADD_COMPUTER_WORDS.notCopied);
      await waitFor(() => expect(line.querySelector("[data-k='not-copied']")).toBeNull(), { timeout: 2500 });
    } finally {
      Object.assign(navigator, { clipboard: { writeText: write } });
    }
  });
});

describe("the list the four place events keep", () => {
  it("appends a computer that joined, moves it as its link comes and goes, and drops it when it is removed", () => {
    useStore.setState({ places: [here] });
    const apply = useStore.getState().applyEvent;
    apply({ type: "place.joined", place: { ...laptop, present: false }, from: "192.168.1.34" });
    expect(useStore.getState().places.map(p => p.id)).toEqual(["here", "p_1"]);
    apply({ type: "place.present", placeId: "p_1", from: "192.168.1.34" });
    expect(useStore.getState().places.find(p => p.id === "p_1")?.present).toBe(true);
    apply({ type: "place.absent", placeId: "p_1" });
    expect(useStore.getState().places.find(p => p.id === "p_1")?.present).toBe(false);
    apply({ type: "place.removed", placeId: "p_1" });
    expect(useStore.getState().places.map(p => p.id)).toEqual(["here"]);
  });
});

describe("the road to the page", () => {
  it("reads the host's setup once for the whole page, whatever the page draws from it", async () => {
    let reads = 0;
    const api = settingsApi({
      initGet: async () => {
        reads += 1;
        return setupOf({ keys: { solari: true } });
      },
    } as Partial<Api>).api;
    useStore.setState({ places: [here, solari] });
    await mountComputers(api);
    expect(reads).toBe(1);
    expect(listIds()).toEqual(["here", "solari"]);
  });

  it("stands in the sidebar's foot with its chord, so Settings is never reachable only by a chord", () => {
    render(<SettingsRow />);
    const row = screen.getByRole("button");
    expect(row.textContent).toContain("Settings");
    expect(row.textContent).toContain("⌘,");
    fireEvent.click(row);
    expect(useStore.getState().settingsOpen).toBe(true);
  });

  it("opens the page on its Add a computer section when a road asks for it", async () => {
    useStore.getState().openAddComputer();
    expect(useStore.getState().settingsOpen).toBe(true);
    mountSettings({ api: settingsApi().api });
    await settle();
    expect(document.querySelector("[data-k='add-computer']")).toBeTruthy();
    expect(pageAt()).toBe("computers");
  });
});
