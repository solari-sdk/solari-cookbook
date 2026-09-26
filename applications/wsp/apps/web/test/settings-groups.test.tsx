// SPDX-License-Identifier: AGPL-3.0-only
// The five groups beside Appearance and Computers: Projects with each
// project's page and its one act, Devices with Revoke, Account's one row,
// Keybindings as lines per platform, and About's lines with the newest release.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { DEFAULT_KEYBINDINGS } from "../src/keybindingDefaults.js";
import { KEYBINDING_COMMANDS, type KeybindingCommand } from "../src/keybindingTypes.js";
import type { BundleOutcome, DesktopBridge, DeviceView, PlaceView, ProjectView, ReleaseView, WorkspaceView } from "@wsp/protocol";
import { DAEMON_VERSION, DEFAULT_PREFERENCES, DEVICES_TICKET_REFUSAL, HOST_NO_RESTART_LINE, UP_RESTART_LINE, fmtBytes, projectInUseRefusal } from "@wsp/protocol";
import { DisconnectedError, RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { ABOUT_WORDS, ACCOUNT_WORDS, DEVICES_WORDS, KEYBINDINGS_WORDS, PRIVACY_WORDS, PROJECTS_WORDS, WHERE_WORDS } from "../src/settings/format.js";
import { builtWhen } from "../src/settings/image.js";
import { chordsOf, keybindingCards } from "../src/settings/keybindings.js";
import { JUMP_WORD, KEYBINDING_WORDS } from "../src/settings/keybindingWords.js";
import { placeName } from "../src/settings/places.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { crumb, descriptionOf, lineLabels, lineOf, mountSettings, pageAt, resetSettings, rowOf, rowTitles, settingsApi, settle, wordOf } from "./settings-harness.js";
import { lastNotice } from "./notice-text.js";
import { useNotices } from "../src/notices/store.js";
import { pickOption } from "./select.js";

const AT = "2026-09-12T09:14:00.000Z";
const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false };
const box: PlaceView = { id: "p_spoo", kind: "computer", name: "spoo", default: false, present: true, takesForks: true };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true };
const project = (id: string, name: string, computer = "here", over: Partial<ProjectView> = {}): ProjectView => ({ id, name, computer, source: { kind: "folder", path: `/Users/dev/${name}` }, path: `/Users/dev/${name}`, remote: `https://github.com/dev/${name}.git`, defaultBranch: "main", memoryKey: `-Users-dev-${name}`, memoryDir: `/Users/dev/.claude-cfg/projects/-Users-dev-${name}/memory`, createdAt: AT, ...over });
const view = (id: string, name: string, projectId: string): WorkspaceView => ({ id, name, machineId: `m_${id}`, kind: "local", project: { id: projectId, name: "spoo", path: "/Users/dev/spoo", computer: "here" }, phase: "running", golden: "", createdAt: AT });
const device = (id: string, name: string, over: Partial<DeviceView> = {}): DeviceView => ({ id, name, createdAt: "2026-09-01T00:00:00Z", lastSeenAt: new Date(Date.now() - 12 * 60_000).toISOString(), ...over });

const mount = async (over: Partial<Api>, group: "projects" | "devices" | "account" | "keybindings" | "about"): Promise<void> => {
  mountSettings({ api: settingsApi(over).api, at: { kind: "group", group } });
  await settle();
};

beforeEach(() => {
  resetSettings();
});

afterEach(() => {
  document.body.innerHTML = "";
  delete window.wsp;
  delete (window as unknown as { __WSP__?: unknown }).__WSP__;
});

describe("Projects", () => {
  it("a refused project list is said where the rows stand, never as no projects", async () => {
    useStore.setState({ projects: [], projectsRefused: { said: "projects.json is not valid JSON", fix: "Restore it from projects.json.bak.", kind: undefined, disconnected: false } });
    await mount({}, "projects");
    expect(rowOf("none")).toBeNull();
    expect(document.querySelector("[data-k='projects-refused']")?.textContent).toBe("Projects not read: projects.json is not valid JSON Restore it from projects.json.bak.");
  });

  it("a refused remove is an error notice with the host's fix, and a lost socket says nothing", async () => {
    let refuse: () => never = () => { throw new RequestError("a workspace stands on it Remove the workspace first.", "conflict", "Remove the workspace first."); };
    useStore.setState({ places: [here, box], projects: [project("pr_landing", "landing", "p_spoo")] });
    await mount({ projectsRemove: async () => refuse() } as Partial<Api>, "projects");
    act(() => useSettingsStore.getState().go({ kind: "project", id: "pr_landing" }));
    await settle();
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=remove-project]")!);
    // A refused remove leaves the ask standing, so the second try is the same confirm pressed again.
    const confirm = async (): Promise<void> => {
      fireEvent.click(document.querySelector("[data-k=remove-project-confirm]")!);
      await settle();
    };
    await confirm();
    expect(useNotices.getState().notices.map(n => [n.kind, n.text])).toEqual([["error", "a workspace stands on it Remove the workspace first."]]);
    useNotices.getState().clear();
    refuse = () => { throw new DisconnectedError("lost"); };
    await confirm();
    expect(useNotices.getState().notices).toEqual([]);
    // The ask is still open in its portal; unmount it before the page is wiped.
    cleanup();
  });

  it("lists one row per project with its glyph, the computer it is on then its source, and the workspace count, and the empty state with the button", async () => {
    useStore.setState({ places: [here, box], projects: [project("pr_spoo", "spoo"), project("pr_landing", "landing", "p_spoo", { source: { kind: "github", repo: "dev/landing" } })], workspaces: [view("ws_a", "pricing page", "pr_spoo"), view("ws_b", "webhook retries", "pr_spoo")] });
    await mount({}, "projects");
    expect(rowTitles()).toEqual(["spoo", "landing"]);
    expect(descriptionOf("pr_spoo")).toBe(`${placeName(here, true)} /Users/dev/spoo`);
    expect(rowOf("pr_spoo")!.querySelector("svg")).not.toBeNull();
    expect(wordOf("pr_spoo")).toBe("2");
    expect(descriptionOf("pr_landing")).toBe("spoo dev/landing");
    // A loaded zero is a fact: a blank where a sibling reads 2 cannot be told from a count that never arrived.
    expect(wordOf("pr_landing")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: PROJECTS_WORDS.add }));
    await waitFor(() => expect(document.querySelector("[data-k=add-project]")).not.toBeNull());
    act(() => useSettingsStore.getState().closeAddProject());
    act(() => useStore.setState({ projects: [] }));
    await settle();
    expect(rowTitles()).toEqual([PROJECTS_WORDS.none]);
    expect(descriptionOf("none")).toBe(PROJECTS_WORDS.noneDescription);
    expect(screen.getByRole("button", { name: PROJECTS_WORDS.add })).toBeTruthy();
  });

  it("a project's page says its lines, its two rows, and Remove held with the refusal while a workspace stands, else asks with the line for the computer's kind and lands the runtime's answer as the toast", async () => {
    const removed: string[] = [];
    const spoo = project("pr_spoo", "spoo", "here", { base: "release", lastAgent: "codex", seeded: { files: 412, bytes: 3_250_000, memory: "landed", commits: 9, at: AT } });
    useStore.setState({ places: [here, box, solari], projects: [spoo, project("pr_landing", "landing", "p_spoo"), project("pr_cloud", "cloud", "solari")], workspaces: [view("ws_a", "pricing page", "pr_spoo")] });
    await mount(
      {
        projectsRemove: async (id: string) => {
          removed.push(id);
          return { said: "landing is no longer a project on spoo" };
        },
      } as Partial<Api>,
      "projects",
    );
    fireEvent.click(rowOf("pr_spoo")!);
    expect(pageAt()).toBe("project:pr_spoo");
    expect(crumb()).toBe("Settings/Projects/spoo");
    expect(lineLabels()).toEqual([PROJECTS_WORDS.source, PROJECTS_WORDS.computer, PROJECTS_WORDS.remote, PROJECTS_WORDS.added, PROJECTS_WORDS.seeded]);
    expect(wordOf("source")).toBe("/Users/dev/spoo");
    expect(wordOf("computer")).toBe("This Mac");
    expect(wordOf("remote")).toBe("https://github.com/dev/spoo.git");
    expect(lineOf("remote")?.getAttribute("title")).toBe(PROJECTS_WORDS.remoteHover);
    expect(wordOf("added")).toMatch(/^Sep 12 \d\d:\d\d$/);
    expect(wordOf("seeded")).toBe(`412 files ${fmtBytes(3_250_000)} memory landed`);
    // About comes first, then Look with its two selects, then what a new workspace starts from.
    expect([...document.querySelectorAll("[data-settings-page] [data-settings-head]")].map(h => h.textContent)).toEqual([PROJECTS_WORDS.about, PROJECTS_WORDS.look, PROJECTS_WORDS.newWorkspaces]);
    expect(rowTitles()).toEqual([PROJECTS_WORDS.icon, PROJECTS_WORDS.hue, PROJECTS_WORDS.branch, PROJECTS_WORDS.lastAgent, "Remove spoo"]);
    expect(wordOf("branch")).toBe("release");
    expect(wordOf("last-agent")).toBe("Codex");
    // A workspace stands on it: the button is held with no title and the refusal is the description.
    const remove = (): HTMLElement => document.querySelector<HTMLElement>("[data-k=remove-project]")!;
    expect(remove().hasAttribute("disabled")).toBe(true);
    expect(remove().hasAttribute("title")).toBe(false);
    // Held, it is the neutral outline further down the opacity ramp, with no hue of its own anywhere.
    expect(remove().className).not.toMatch(/warning|bg-destructive/);
    expect(remove().className).toContain("disabled:opacity-50");
    expect(remove().className).toContain("border-input");
    expect(descriptionOf("remove")).toBe(projectInUseRefusal("spoo", ["pricing page"]));
    // A project on a joined computer: the line names wsp's own clone there.
    act(() => useSettingsStore.getState().go({ kind: "project", id: "pr_landing" }));
    await settle();
    expect(wordOf("computer")).toBe("spoo");
    expect(wordOf("branch")).toBe("main");
    expect(rowOf("last-agent")).toBeNull();
    expect(descriptionOf("remove")).toBe(PROJECTS_WORDS.removeOnComputer("spoo"));
    expect(remove().hasAttribute("disabled")).toBe(false);
    fireEvent.click(remove());
    expect(document.querySelector("[data-k=remove-project-title]")?.textContent).toBe("Remove landing?");
    expect(document.querySelector("[data-k=remove-project-sentence]")?.textContent).toBe(PROJECTS_WORDS.removeOnComputer("spoo"));
    expect(document.querySelector<HTMLElement>("[data-k=remove-project-confirm]")!.className).toContain("bg-destructive");
    fireEvent.click(document.querySelector("[data-k=remove-project-confirm]")!);
    await waitFor(() => expect(removed).toEqual(["pr_landing"]));
    await waitFor(() => expect(lastNotice()).toBe("landing is no longer a project on spoo"));
    // The runtime's word on a removal that went through is not a failure.
    expect(useNotices.getState().notices[0]?.kind).toBe("done");
    expect(pageAt()).toBe("projects");
    // A project at a cloud: the line names its image there.
    act(() => useSettingsStore.getState().go({ kind: "project", id: "pr_cloud" }));
    await settle();
    expect(descriptionOf("remove")).toBe(PROJECTS_WORDS.removeAtCloud("Solari"));
  });
});

describe("a project's Look", () => {
  it("reads the record's look into the two selects and writes a pick as that project's look", async () => {
    useStore.setState({ places: [here], projects: [project("pr_spoo", "spoo")], workspaces: [] });
    const { api, sets } = settingsApi({}, { ...DEFAULT_PREFERENCES, labs: false, projectLook: { pr_spoo: { icon: "rocket" } } });
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false, projectLook: { pr_spoo: { icon: "rocket" } } } });
    mountSettings({ api, at: { kind: "project", id: "pr_spoo" } });
    await settle();
    const iconSelect = document.querySelector<HTMLElement>("[data-settings-page] [data-k=project-icon]")!;
    const hueSelect = document.querySelector<HTMLElement>("[data-settings-page] [data-k=project-hue]")!;
    expect(iconSelect.textContent).toBe("Rocket");
    expect(hueSelect.textContent).toBe("Neutral");
    await pickOption(hueSelect, "Teal");
    await waitFor(() => expect(sets).toEqual([{ projectLook: { pr_spoo: { icon: "rocket", hue: "teal" } } }]));
    // The select leaves a portal React must unmount itself before the file's teardown empties the body.
    cleanup();
  });
});

describe("Devices", () => {
  it("a refused revoke is an error notice with the host's fix, and a lost socket says nothing", async () => {
    let refuse: () => never = () => { throw new RequestError("that device is already gone Read the list again.", "gone", "Read the list again."); };
    await mount({ devicesList: async () => [device("d_1", "zingzy-laptop")], devicesRevoke: async () => refuse() } as Partial<Api>, "devices");
    fireEvent.click(rowOf("d_1")!.querySelector<HTMLElement>("[data-k=revoke]")!);
    const confirm = async (): Promise<void> => {
      fireEvent.click(document.querySelector("[data-k=revoke-confirm]")!);
      await settle();
    };
    await confirm();
    expect(useNotices.getState().notices.map(n => [n.kind, n.text])).toEqual([["error", "that device is already gone Read the list again."]]);
    useNotices.getState().clear();
    refuse = () => { throw new DisconnectedError("lost"); };
    await confirm();
    expect(useNotices.getState().notices).toEqual([]);
    cleanup();
  });

  it("lists one row per unscoped device with paired and seen, names this browser, and Revoke asks, calls the host and rereads", async () => {
    const revoked: string[] = [];
    let devices: DeviceView[] = [device("d_1", "zingzy-laptop"), device("d_2", "Safari on iPhone", { here: true, lastSeenAt: new Date().toISOString() }), device("d_3", "a thread's token", { scope: { kind: "thread", workspaceId: "ws_a", threadId: "th_1", rootThreadId: "th_1" } })];
    await mount(
      {
        devicesList: async () => devices,
        devicesRevoke: async (id: string) => {
          revoked.push(id);
          devices = devices.filter(d => d.id !== id);
        },
      } as Partial<Api>,
      "devices",
    );
    expect(rowTitles()).toEqual(["zingzy-laptop", DEVICES_WORDS.thisBrowser]);
    expect(descriptionOf("d_1")).toMatch(/^paired Sep 1 \d\d:\d\d seen 1[12] min ago$/);
    // A device heard from inside the minute says so in words rather than as a span of zero.
    expect(descriptionOf("d_2")).toMatch(/^paired Sep 1 \d\d:\d\d seen just now$/);
    expect(rowOf("d_1")?.querySelector("[data-settings-description]")?.className).toContain("font-mono");
    // The door to the confirmation is neutral where it stands and red only under the pointer; the act itself, in
    // the dialog, is the one red thing at rest.
    const revoke = rowOf("d_1")!.querySelector<HTMLElement>("[data-k=revoke]")!;
    expect(revoke.className).not.toMatch(/warning/);
    expect(revoke.className).toContain("text-foreground");
    expect(revoke.className).toContain("[:hover,[data-pressed]]:text-destructive-foreground");
    fireEvent.click(revoke);
    expect(document.querySelector("[data-k=revoke-title]")?.textContent).toBe("Revoke zingzy-laptop?");
    expect(document.querySelector("[data-k=revoke-sentence]")?.textContent).toBe(DEVICES_WORDS.revokeDescription);
    const confirm = document.querySelector<HTMLElement>("[data-k=revoke-confirm]")!;
    expect(confirm.className).toContain("bg-destructive");
    expect(confirm.className).not.toMatch(/warning/);
    fireEvent.click(confirm);
    await waitFor(() => expect(revoked).toEqual(["d_1"]));
    await waitFor(() => expect(rowTitles()).toEqual([DEVICES_WORDS.thisBrowser]));
    // Account holds no second list of them.
    act(() => useSettingsStore.getState().go({ kind: "group", group: "account" }));
    await settle();
    expect(document.body.textContent).not.toContain(DEVICES_WORDS.thisBrowser);
  });

  it("holds Revoke and says why in the row where this wsp carries no such request", async () => {
    await mount({ devicesList: async () => [device("d_1", "zingzy-laptop")] } as Partial<Api>, "devices");
    const revoke = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("[data-k=revoke]")!;
    expect(revoke().disabled).toBe(true);
    expect(revoke().hasAttribute("title")).toBe(false);
    expect(descriptionOf("d_1")).toMatch(new RegExp(` ${WHERE_WORDS.notYet}$`));
  });

  it("says one line where nothing is paired, and one where a page served on a ticket socket is refused the list", async () => {
    await mount({ devicesList: async () => [] } as Partial<Api>, "devices");
    expect(lineLabels()).toEqual([DEVICES_WORDS.none]);
    document.body.innerHTML = "";
    resetSettings();
    await mount({ devicesList: async () => Promise.reject(new Error(DEVICES_TICKET_REFUSAL)) } as Partial<Api>, "devices");
    expect(lineLabels()).toEqual([DEVICES_WORDS.refused]);
  });
});

describe("Account", () => {
  it("says nothing but the sentences and the held button with no title while nobody is signed in; signed in reads the login and offers Sign out", async () => {
    await mount({ account: async () => ({ signedIn: false }) } as Partial<Api>, "account");
    expect(rowTitles()).toEqual([ACCOUNT_WORDS.github]);
    // No word for being signed in or not: the button standing there is that state, and the room is the sentence's.
    expect(wordOf("github")).toBeUndefined();
    expect(descriptionOf("github")).toBe(ACCOUNT_WORDS.reach);
    const action = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("[data-k=account-action]")!;
    expect(action().textContent).toBe(ACCOUNT_WORDS.signIn);
    expect(action().disabled).toBe(true);
    expect(action().hasAttribute("title")).toBe(false);
    expect(action().className).toContain("disabled:opacity-50");
    document.body.innerHTML = "";
    resetSettings();
    await mount({ account: async () => ({ signedIn: true, login: "zingzy" }) } as Partial<Api>, "account");
    expect(wordOf("github")).toBe("zingzy");
    expect(action().textContent).toBe(ACCOUNT_WORDS.signOut);
    expect(descriptionOf("github")).toBe(ACCOUNT_WORDS.reachable);
    // A host that refuses the read leaves the slot empty and keeps the sentence.
    document.body.innerHTML = "";
    resetSettings();
    await mount({ account: async () => Promise.reject(new Error("this host keeps no account records")) } as Partial<Api>, "account");
    expect(wordOf("github")).toBeUndefined();
    expect(descriptionOf("github")).toBe(ACCOUNT_WORDS.reach);
  });
});

describe("Privacy", () => {
  it("offers server icons from Google as one switch, on by default, that writes the record and restores to on", async () => {
    const { api, sets } = settingsApi();
    mountSettings({ api, at: { kind: "group", group: "privacy" } });
    await settle();
    expect(rowTitles()).toEqual([PRIVACY_WORDS.serverIcons, PRIVACY_WORDS.agentVersions]);
    expect(descriptionOf("server-icons")).toBe(PRIVACY_WORDS.serverIconsDescription);
    expect(PRIVACY_WORDS.serverIconsDescription).toBe("wsp asks Google for each public server's icon by host name; turning this off deletes the saved icons.");
    const toggle = (): HTMLElement => document.querySelector<HTMLElement>("[data-k=server-icons]")!;
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle());
    await settle();
    expect(sets).toEqual([{ serverIcons: false }]);
    expect(useStore.getState().preferences.serverIcons).toBe(false);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=restore-defaults]")!);
    await settle();
    expect(sets.at(-1)).toEqual({ serverIcons: true, agentVersions: true });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("offers agent version checks as a second switch, on by default, and holds it off where the host's environment turned update checks off", async () => {
    const { api, sets } = settingsApi();
    mountSettings({ api, at: { kind: "group", group: "privacy" } });
    await settle();
    expect(descriptionOf("agent-versions")).toBe(PRIVACY_WORDS.agentVersionsDescription);
    const toggle = (): HTMLElement => document.querySelector<HTMLElement>("[data-k=agent-versions]")!;
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle());
    await settle();
    expect(sets).toEqual([{ agentVersions: false }]);
    expect(useStore.getState().preferences.agentVersions).toBe(false);
    act(() => useStore.setState({ preferences: { ...useStore.getState().preferences, agentVersions: true }, release: { state: "off", shape: "service" } }));
    await settle();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().hasAttribute("data-disabled")).toBe(true);
    expect(toggle().closest("[title]")?.getAttribute("title")).toBe(PRIVACY_WORDS.agentVersionsHeld);
  });
});

describe("Keybindings", () => {
  const mac = { platform: "MacIntel", desktopShell: true };
  const label = (command: KeybindingCommand, read = mac): string[][] => chordsOf(DEFAULT_KEYBINDINGS, command, read);

  it("words every command in the closed set, so a command added to it must get its words", () => {
    expectTypeOf(KEYBINDING_WORDS).toEqualTypeOf<Record<KeybindingCommand, string>>();
    for (const command of KEYBINDING_COMMANDS) expect(KEYBINDING_WORDS[command]).not.toBe("");
  });

  it("draws one line per default rule with the chord's keycaps per platform, both where a command has two, the nine jumps as one line, and drops in a tab what the tab keeps", () => {
    expect(label("commandPalette.toggle")).toEqual([["⌘K"]]);
    expect(label("settings.toggle")).toEqual([["⌘,"]]);
    expect(label("chat.new")).toEqual([["⌘N"], ["⌘T"]]);
    expect(label("workspace.next")).toEqual([["⌥⌘Right"], ["⌃Tab"]]);
    expect(label("terminal.zoomIn")).toEqual([["⌘="], ["⇧⌘="]]);
    expect(label("workspace.select.1")).toEqual([["⌘1"], ["⌘9"]]);
    // On another platform the same rules read Ctrl.
    expect(label("commandPalette.toggle", { platform: "Linux x86_64", desktopShell: true })).toEqual([["Ctrl+K"]]);
    // In a browser tab the chords the tab keeps are not drawn: New thread reads its one remaining chord, the
    // workspace switch on a Mac has none left and the thread switch keeps its arrows.
    const tab = { platform: "MacIntel", desktopShell: false };
    expect(label("chat.new", tab)).toEqual([["⌘N"]]);
    expect(label("workspace.next", tab)).toEqual([]);
    expect(label("thread.next", tab)).toEqual([["⌥⌘Down"]]);
    expect(label("workspace.select.1", tab)).toEqual([]);
    const cards = keybindingCards(DEFAULT_KEYBINDINGS, mac);
    expect(cards.map(card => card.head)).toEqual([undefined, KEYBINDINGS_WORDS.workspacesAndThreads, KEYBINDINGS_WORDS.terminal, KEYBINDINGS_WORDS.fixed]);
    expect(cards[0]!.items.map(item => (item.kind === "line" ? item.label : ""))).toEqual(["Search", "Settings", "Toggle the sidebar", "Toggle the terminal drawer", "Toggle the right panel", "Toggle the preview"]);
    expect(cards[1]!.items.map(item => (item.kind === "line" ? item.label : ""))).toEqual(["New thread", "Next task", "Previous task", "Next thread", "Previous thread", JUMP_WORD]);
    expect(cards[3]!.items.map(item => (item.kind === "line" ? [item.label, item.keys] : []))).toEqual([
      [KEYBINDINGS_WORDS.sendMessage, [["Enter"]]],
      [KEYBINDINGS_WORDS.submitComment, [["⌘Enter"]]],
      [KEYBINDINGS_WORDS.leaveSettings, [["Esc"]]],
    ]);
  });

  it("stands on the page as lines with keycaps, no row and no description", async () => {
    window.wsp = {};
    await mount({}, "keybindings");
    expect(rowTitles()).toEqual([]);
    expect(lineLabels()).toContain("Search");
    expect(document.querySelectorAll("[data-settings-page] [data-slot=kbd]").length).toBeGreaterThan(10);
    expect(document.querySelector("[data-settings-page] [data-command='chat.new'] [data-settings-keys]")?.textContent).toMatch(/N.*T$|N$/);
  });
});

describe("About", () => {
  it("says the app's half and the host's in the shell, the host's alone in a tab, unknown where the shell names none, and Releases opens the releases page", async () => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPort: 1, tokenHash: "a".repeat(64), wsPath: "/ws", paired: true, version: "0.1.5" };
    window.wsp = { version: "0.1.3" };
    await mount({}, "about");
    expect(lineLabels()).toEqual([ABOUT_WORDS.app, ABOUT_WORDS.host]);
    expect(document.querySelector("[data-k=app-version] [data-settings-word]")?.textContent).toBe("0.1.3");
    expect(document.querySelector("[data-k=host-version] [data-settings-word]")?.textContent).toBe("0.1.5");
    expect(document.querySelector("[data-k=host-version] [data-settings-word]")?.className).toContain("font-mono");
    expect(rowTitles()).toEqual([]);
    let opened: string | undefined;
    window.open = ((url: string) => {
      opened = url;
      return null;
    }) as typeof window.open;
    fireEvent.click(screen.getByRole("button", { name: ABOUT_WORDS.releases }));
    expect(opened).toMatch(/\/releases$/);
    document.body.innerHTML = "";
    resetSettings();
    delete window.wsp;
    await mount({}, "about");
    expect(lineLabels()).toEqual([ABOUT_WORDS.host]);
    document.body.innerHTML = "";
    resetSettings();
    window.wsp = {};
    await mount({}, "about");
    expect(document.querySelector("[data-k=app-version] [data-settings-word]")?.textContent).toBe(ABOUT_WORDS.unknown);
  });
});

describe("About and the newest release", () => {
  const DAY = 24 * 60 * 60_000;
  const read = (version: string, over: Partial<ReleaseView> = {}): ReleaseView => ({
    state: "read",
    latest: { version, tag: `v${version}`, url: `https://github.com/Zingzy/wsp/releases/tag/v${version}`, publishedAt: AT },
    // An hour past the day, so the page's minute clock reads the same whole days as this one.
    checkedAt: new Date(Date.now() - 3 * DAY - 60 * 60_000).toISOString(),
    triedAt: new Date(Date.now() - 3 * DAY - 60 * 60_000).toISOString(),
    shape: "app",
    ...over,
  });
  const shell = (app: string | undefined, host: string): void => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPort: 1, tokenHash: "a".repeat(64), wsPath: "/ws", paired: true, version: host };
    if (app === undefined) delete window.wsp;
    else window.wsp = { version: app };
  };
  const latest = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-k=latest-version]");
  const latestWord = (): string | undefined => latest()?.querySelector("[data-settings-word]")?.textContent ?? undefined;
  const inks = (): string[] => (latest()?.querySelector("[data-settings-word]")?.className ?? "").split(" ");
  const show = async (release: ReleaseView | null): Promise<void> => {
    act(() => useStore.setState({ release }));
    await settle();
  };
  const buttons = (): string[] => [...document.querySelectorAll("[data-settings-card=about] button")].map(b => b.textContent ?? "");
  const aboutMeta = (): string | undefined => document.querySelector("[data-k=settings-about] [data-settings-meta]")?.textContent ?? undefined;

  it("says the number in the value ink while it is above the app or the host, in the fact ink when level or ahead, and the state word only while nothing was ever read", async () => {
    shell("0.2.0", "0.2.0");
    await mount({}, "about");
    // A host with no reading to give draws no line rather than a word it never said.
    expect(lineLabels()).toEqual([ABOUT_WORDS.app, ABOUT_WORDS.host]);
    await show(read("0.3.0"));
    expect(lineLabels()).toEqual([ABOUT_WORDS.app, ABOUT_WORDS.host, ABOUT_WORDS.latest]);
    expect(latestWord()).toBe("0.3.0");
    expect(inks()).toContain("text-foreground");
    expect(latest()?.title).toBe(ABOUT_WORDS.readHover("3 d ago"));
    // Ahead of the page's minute clock, as a reading the opening itself asked for is.
    await show(read("0.3.0", { checkedAt: new Date(Date.now() + 5_000).toISOString() }));
    expect(latest()?.title).toBe(ABOUT_WORDS.readHover("just now"));
    await show(read("0.2.0"));
    expect(latestWord()).toBe("0.2.0");
    expect(inks()).toContain("text-muted-foreground");
    // A reading kept through a failed ask stands, with the failure in the hover rather than in the slot.
    const tried = new Date(Date.now() - 5 * 60_000).toISOString();
    await show(read("0.3.0", { state: "unreached", triedAt: tried }));
    expect(latestWord()).toBe("0.3.0");
    expect(latest()?.title).toBe(ABOUT_WORDS.missedHover("3 d ago", builtWhen(tried)));
    for (const [state, word] of [["checking", "checking"], ["unreached", "unreached"], ["off", "off"]] as const) {
      await show({ state, shape: "app", ...(state === "unreached" ? { triedAt: tried } : {}) });
      expect(latestWord()).toBe(word);
      expect(inks()).toContain("text-muted-foreground");
    }
    expect(latest()?.title).toBe(ABOUT_WORDS.offHover);
  });

  it("reads the app's half as behind too, and a tab with no shell reads the host alone", async () => {
    shell("0.2.0", "0.3.0");
    useStore.setState({ release: read("0.3.0") });
    await mount({}, "about");
    expect(inks()).toContain("text-foreground");
    expect(buttons()).toContain(ABOUT_WORDS.get("0.3.0"));
    document.body.innerHTML = "";
    resetSettings();
    shell(undefined, "0.3.0");
    useStore.setState({ release: read("0.3.0") });
    await mount({}, "about");
    expect(inks()).toContain("text-muted-foreground");
    expect(buttons()).not.toContain(ABOUT_WORDS.get("0.3.0"));
  });

  it("offers Get with the release's page while behind, keeps Releases on the releases list, and offers nothing new when level", async () => {
    shell("0.2.0", "0.2.0");
    useStore.setState({ release: read("0.3.0") });
    await mount({}, "about");
    const opened: string[] = [];
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    expect(buttons()).toEqual([ABOUT_WORDS.get("0.3.0"), ABOUT_WORDS.releases]);
    fireEvent.click(screen.getByRole("button", { name: ABOUT_WORDS.get("0.3.0") }));
    fireEvent.click(screen.getByRole("button", { name: ABOUT_WORDS.releases }));
    expect(opened).toEqual(["https://github.com/Zingzy/wsp/releases/tag/v0.3.0", "https://github.com/Zingzy/wsp/releases"]);
    await show(read("0.2.0"));
    expect(buttons()).toEqual([ABOUT_WORDS.releases]);
    fireEvent.click(screen.getByRole("button", { name: ABOUT_WORDS.releases }));
    expect(opened.at(-1)).toMatch(/\/releases$/);
    // Under the switch no number stands, so nothing is offered off a stale one.
    await show({ state: "off", shape: "app" });
    expect(buttons()).toEqual([ABOUT_WORDS.releases]);
  });

  const opens = (): string[] => {
    const opened: string[] = [];
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    return opened;
  };
  const HOVER = "Downloads the disk image and checks its sha256.";
  const shellOn = (current: string | null, bundle: Pick<DesktopBridge, "getBundle" | "quitAndOpen">, app = "0.2.0", host = "0.2.0"): void => {
    shell(app, host);
    window.wsp = { version: app, bundleHover: HOVER, hosts: async () => ({ here: "this Mac", current, hosts: [] }), ...bundle };
  };

  it("in the app on its own host, Get downloads through the shell, says Downloading, then Quit and open, which hands over to the shell", async () => {
    let done: (outcome: BundleOutcome) => void = () => undefined;
    const getBundle = vi.fn((_ask: { version: string }) => new Promise<BundleOutcome>(resolve => (done = resolve)));
    const quitAndOpen = vi.fn(async (): Promise<BundleOutcome> => ({ ok: true }));
    shellOn(null, { getBundle, quitAndOpen });
    useStore.setState({ release: read("0.3.0") });
    await mount({}, "about");
    const opened = opens();
    const get = screen.getByRole("button", { name: ABOUT_WORDS.get("0.3.0") });
    await waitFor(() => expect(get.title).toBe(HOVER));
    fireEvent.click(get);
    expect(getBundle).toHaveBeenCalledWith({ version: "0.3.0" });
    await waitFor(() => expect(buttons()).toEqual([ABOUT_WORDS.downloading, ABOUT_WORDS.releases]));
    expect(screen.getByRole("button", { name: ABOUT_WORDS.downloading }).hasAttribute("disabled")).toBe(true);
    await act(async () => done({ ok: true }));
    await waitFor(() => expect(buttons()).toEqual([ABOUT_WORDS.quitAndOpen, ABOUT_WORDS.releases]));
    fireEvent.click(screen.getByRole("button", { name: ABOUT_WORDS.quitAndOpen }));
    await waitFor(() => expect(quitAndOpen).toHaveBeenCalledTimes(1));
    expect(opened).toEqual([]);
  });

  it("a download the shell refuses lands its line as an error notice and puts Get back", async () => {
    const getBundle = vi.fn(async (): Promise<BundleOutcome> => ({ ok: false, error: "wsp-0.3.0-mac.dmg did not match the release's sha256 and was deleted" }));
    shellOn(null, { getBundle, quitAndOpen: vi.fn() });
    useStore.setState({ release: read("0.3.0") });
    await mount({}, "about");
    await waitFor(() => expect(screen.getByRole("button", { name: ABOUT_WORDS.get("0.3.0") }).title).toBe(HOVER));
    fireEvent.click(screen.getByRole("button", { name: ABOUT_WORDS.get("0.3.0") }));
    await waitFor(() => expect(useNotices.getState().notices.slice(0, 1).map(n => [n.kind, n.text])).toEqual([["error", "wsp-0.3.0-mac.dmg did not match the release's sha256 and was deleted"]]));
    expect(buttons()).toEqual([ABOUT_WORDS.get("0.3.0"), ABOUT_WORDS.releases]);
  });

  it("an open the shell refuses lands its line as an error notice and puts Get back", async () => {
    const quitAndOpen = vi.fn(async (): Promise<BundleOutcome> => ({ ok: false, error: "wsp-0.3.0-mac.dmg changed after it was checked and was not opened" }));
    shellOn(null, { getBundle: vi.fn(async (): Promise<BundleOutcome> => ({ ok: true })), quitAndOpen });
    useStore.setState({ release: read("0.3.0") });
    await mount({}, "about");
    await waitFor(() => expect(screen.getByRole("button", { name: ABOUT_WORDS.get("0.3.0") }).title).toBe(HOVER));
    fireEvent.click(screen.getByRole("button", { name: ABOUT_WORDS.get("0.3.0") }));
    fireEvent.click(await screen.findByRole("button", { name: ABOUT_WORDS.quitAndOpen }));
    await waitFor(() => expect(useNotices.getState().notices.slice(0, 1).map(n => n.text)).toEqual(["wsp-0.3.0-mac.dmg changed after it was checked and was not opened"]));
    await waitFor(() => expect(buttons()).toEqual([ABOUT_WORDS.get("0.3.0"), ABOUT_WORDS.releases]));
  });

  it("where only the host is behind, Get is the link to the release's page and the shell downloads nothing", async () => {
    const getBundle = vi.fn(async (): Promise<BundleOutcome> => ({ ok: true }));
    const hosts = vi.fn(async () => ({ here: "this Mac", current: null, hosts: [] }));
    shellOn(null, { getBundle, quitAndOpen: vi.fn() }, "0.3.0", "0.2.0");
    window.wsp = { ...window.wsp, hosts };
    useStore.setState({ release: read("0.3.0") });
    await mount({}, "about");
    const opened = opens();
    await waitFor(() => expect(hosts).toHaveBeenCalled());
    await settle();
    const get = screen.getByRole("button", { name: ABOUT_WORDS.get("0.3.0") });
    expect(get.title).toBe("");
    fireEvent.click(get);
    expect(opened).toEqual(["https://github.com/Zingzy/wsp/releases/tag/v0.3.0"]);
    expect(getBundle).not.toHaveBeenCalled();
  });

  it("a remote page gets the link form: Get opens the release's page and asks the shell for nothing", async () => {
    const getBundle = vi.fn(async (): Promise<BundleOutcome> => ({ ok: true }));
    const hosts = vi.fn(async () => ({ here: "this Mac", current: "spoo", hosts: [] }));
    shellOn("spoo", { getBundle, quitAndOpen: vi.fn() });
    window.wsp = { ...window.wsp, hosts };
    useStore.setState({ release: read("0.3.0") });
    await mount({}, "about");
    const opened = opens();
    await waitFor(() => expect(hosts).toHaveBeenCalled());
    await settle();
    const get = screen.getByRole("button", { name: ABOUT_WORDS.get("0.3.0") });
    expect(get.title).toBe("");
    fireEvent.click(get);
    expect(opened).toEqual(["https://github.com/Zingzy/wsp/releases/tag/v0.3.0"]);
    expect(getBundle).not.toHaveBeenCalled();
  });

  const hostHover = (): string | undefined => document.querySelector<HTMLElement>("[data-k=host-version]")?.title;

  it("offers Restart host in place of Get once the installed files are newer and a restart brings the host back, and the click asks the host", async () => {
    shell("0.2.0", "0.2.0");
    const hostRestart = vi.fn(async () => undefined);
    useStore.setState({ release: read("0.3.0", { installed: "0.3.0", update: "npm i -g @zingzy/wsp@0.3.0" }) });
    await mount({ hostRestart } as Partial<Api>, "about");
    expect(buttons()).toEqual([ABOUT_WORDS.restartHost, ABOUT_WORDS.releases]);
    const restart = screen.getByRole("button", { name: ABOUT_WORDS.restartHost });
    expect(restart.title).toBe(ABOUT_WORDS.restartHover);
    for (const dropped of ["terminal panes", "localhost forwards", "sign-in in progress"]) expect(restart.title).toContain(dropped);
    // The files are already the release, so the hover names the restart and not the install again.
    expect(hostHover()).toBe(ABOUT_WORDS.hostInstalledHover("0.3.0", ABOUT_WORDS.restartRuns));
    fireEvent.click(restart);
    await waitFor(() => expect(hostRestart).toHaveBeenCalledTimes(1));
  });

  it("a restart the host refuses lands its line as an error notice", async () => {
    shell("0.2.0", "0.2.0");
    const hostRestart = vi.fn(async () => {
      throw new RequestError("a socket let in on a ticket cannot restart this host");
    });
    useStore.setState({ release: read("0.3.0", { installed: "0.3.0" }) });
    await mount({ hostRestart } as Partial<Api>, "about");
    fireEvent.click(screen.getByRole("button", { name: ABOUT_WORDS.restartHost }));
    await waitFor(() => expect(useNotices.getState().notices.slice(0, 1).map(n => n.text)).toEqual(["a socket let in on a ticket cannot restart this host"]));
  });

  it("draws no Restart where a restart would not bring the host back, and the Host hover says the terminal's line instead", async () => {
    shell("0.2.0", "0.2.0");
    useStore.setState({ release: read("0.3.0", { shape: "up", installed: "0.3.0", restartRefusal: UP_RESTART_LINE }) });
    await mount({}, "about");
    expect(buttons()).toEqual([ABOUT_WORDS.get("0.3.0"), ABOUT_WORDS.releases]);
    expect(hostHover()).toBe(ABOUT_WORDS.hostInstalledHover("0.3.0", UP_RESTART_LINE));
  });

  it("shows the host's own refusal as it arrives, whatever road it names, and draws no Restart", async () => {
    shell("0.2.0", "0.2.0");
    useStore.setState({ release: read("0.3.0", { shape: "app", installed: "0.3.0", restartRefusal: HOST_NO_RESTART_LINE }) });
    await mount({}, "about");
    expect(buttons()).toEqual([ABOUT_WORDS.get("0.3.0"), ABOUT_WORDS.releases]);
    expect(hostHover()).toBe(ABOUT_WORDS.hostInstalledHover("0.3.0", HOST_NO_RESTART_LINE));
  });

  it("draws no Restart on a page served to another computer, whose restart the host refuses", async () => {
    shell("0.2.0", "0.2.0");
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPort: 1, tokenHash: "a".repeat(64), wsPath: "/ws", paired: false, version: "0.2.0" };
    useStore.setState({ release: read("0.3.0", { installed: "0.3.0" }) });
    await mount({}, "about");
    expect(buttons()).not.toContain(ABOUT_WORDS.restartHost);
    expect(hostHover()).toBe(ABOUT_WORDS.hostInstalledHover("0.3.0", ABOUT_WORDS.restartThere));
  });

  it("the Host hover names the line that moves the host onto the release while it is behind, and the plain words otherwise", async () => {
    shell("0.2.0", "0.2.0");
    useStore.setState({ release: read("0.3.0", { update: "npm i -g @zingzy/wsp@0.3.0" }) });
    await mount({}, "about");
    expect(hostHover()).toBe(ABOUT_WORDS.hostUpdateHover("npm i -g @zingzy/wsp@0.3.0", "0.3.0"));
    await show(read("0.2.0"));
    expect(hostHover()).toBe(ABOUT_WORDS.hostHover);
  });

  it("the About row in the sidebar carries the newer version as its one mono word, and nothing while level", async () => {
    shell("0.2.0", "0.2.0");
    useStore.setState({ release: read("0.3.0") });
    await mount({}, "devices");
    expect(aboutMeta()).toBe("0.3.0");
    expect(document.querySelectorAll("[data-slot=sidebar] [data-settings-meta]").length).toBe(1);
    await show(read("0.2.0"));
    expect(aboutMeta()).toBeUndefined();
    await show({ state: "unreached", shape: "app" });
    expect(aboutMeta()).toBeUndefined();
  });

  it("counts the computers whose daemon is behind in one line, naming them on hover, and draws none while every one is current", async () => {
    shell("0.2.0", "0.2.0");
    const behind = (id: string, name: string): PlaceView => ({ ...box, id, name, daemonVersion: DAEMON_VERSION - 3 });
    useStore.setState({ places: [here, behind("p_spoo", "spoo"), behind("p_dev4", "dev4"), solari, { ...box, id: "p_new", name: "new", daemonVersion: DAEMON_VERSION }] });
    await mount({}, "about");
    expect(lineLabels()).toEqual([ABOUT_WORDS.app, ABOUT_WORDS.host, ABOUT_WORDS.computersBehind]);
    expect(wordOf("computers-behind")).toBe("2");
    expect(lineOf("computers-behind")?.querySelector("[data-settings-word]")?.className.split(" ")).toContain("text-muted-foreground");
    expect(lineOf("computers-behind")?.title).toBe("spoo, dev4: wsp add <name> --update");
    act(() => useStore.setState({ places: [here, behind("p_spoo", "spoo")] }));
    await settle();
    expect(wordOf("computers-behind")).toBe("1");
    expect(lineOf("computers-behind")?.title).toBe("spoo: wsp add spoo --update");
    act(() => useStore.setState({ places: [here, box, solari] }));
    await settle();
    expect(lineOf("computers-behind")).toBeNull();
  });

  it("opening About asks the host to check, which its floor keeps to one ask, and the answer lands on the page", async () => {
    shell("0.2.0", "0.2.0");
    const releaseCheck = vi.fn(async () => read("0.3.0"));
    await mount({ releaseCheck } as Partial<Api>, "devices");
    expect(releaseCheck).not.toHaveBeenCalled();
    act(() => useSettingsStore.getState().go({ kind: "group", group: "about" }));
    await settle();
    expect(releaseCheck).toHaveBeenCalledTimes(1);
    expect(latestWord()).toBe("0.3.0");
  });
});
