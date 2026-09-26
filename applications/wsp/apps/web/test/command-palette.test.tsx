// SPDX-License-Identifier: AGPL-3.0-only
// The palette over the shell: opens on its shortcut, filters, runs actions;
// every default shortcut dispatches into the sidebar, the right panel store
// and the terminal link; when-clauses and typing contexts are respected.
import { act, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, PLACES_WORDS, type SessionView, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { WORKSPACE_WORDS } from "../src/actions/format.js";
import { RECENT_THREAD_LIMIT } from "../src/components/palette/CommandPalette.logic.js";
import { SidebarProvider, useSidebar } from "../src/components/ui/sidebar.js";
import { compileResolvedKeybindingsConfig } from "../src/keybindingDefaults.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { AppShell } from "../src/shell/AppShell.js";
import { KeybindingDispatcher } from "../src/shell/KeybindingDispatcher.js";
import { cancelWorkspaceSwitch, stepInOrder } from "../src/shell/shellCommands.js";
import { onComposerFocusRequest, onNewThreadRequest } from "../src/shell/shellRequests.js";
import { NEW_WORKSPACE, PROJECT_WORDS } from "../src/sidebar/words.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { provideTerminals, WorkspaceTerminals } from "../src/terminal/link.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices, lastNotice } from "./notice-text.js";

// The triggers keep their elements, and no popup mounts: this file focuses the
// sidebar's search row, and Base UI's positioning against jsdom's zero-size
// rects costs seconds per open. The tooltip's own text is covered in
// search-row.test.tsx, where the popup renders inline.
vi.mock("../src/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) =>
    element === undefined ? <>{children}</> : cloneElement(element, {}, children ?? element.props.children),
  TooltipPopup: () => null,
}));

const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running", over: Partial<WorkspaceView> = {}): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase,
  golden: "snap_g",
  createdAt: `2026-09-01T00:0${id.length}:00Z`,
  ...over,
});

const session = (id: string, workspaceId: string, prompt: string, over: Partial<SessionView> = {}): SessionView => ({
  id,
  workspaceId,
  harness: "claude",
  status: "completed",
  prompt,
  startedAt: Date.now() - 60_000,
  ...over,
});

const CAPS = caps();

function fakeApi(workspaces: WorkspaceView[], sessions: SessionView[]): Api & { nap: ReturnType<typeof vi.fn> } {
  return {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: vi.fn(async (id: string) => view(id, "?", "napping")),
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => sessions,
    subscribe: () => () => {},
    getGolden: async () => undefined,
  };
}

/** A terminal link whose daemon is a counter: every pty.create hands out the next id. */
function fakeTerminals(): WorkspaceTerminals {
  let n = 0;
  return new WorkspaceTerminals({
    request: async (op: string) => (op === "pty.create" ? { ptyId: `pty${++n}` } : {}),
  });
}

const mod = (key: string, mods: { shiftKey?: boolean; altKey?: boolean } = {}, target: Element | Window = window) =>
  fireEvent.keyDown(target, { key, code: `Key${key.toUpperCase()}`, metaKey: true, ...mods });

const ctrlTab = (mods: { shiftKey?: boolean } = {}) => fireEvent.keyDown(window, { key: "Tab", code: "Tab", ctrlKey: true, ...mods });
/** The switch between spaces, as macOS spells it here; the platform is mocked to MacIntel for the file. */
const spaceArrow = (name: "ArrowLeft" | "ArrowRight", target: Element | Window = window) =>
  fireEvent.keyDown(target, { key: name, code: name, metaKey: true, altKey: true });
/** One of that chord's hold keys let go, which is what commits a walk the arrows opened. */
const spaceArrowUp = () => fireEvent.keyUp(window, { key: "Alt" });
/** The hold let go, which is what commits the switch; the walk itself only moves the overlay's highlight. */
const ctrlUp = () => fireEvent.keyUp(window, { key: "Control" });
const digit = (n: number) => fireEvent.keyDown(window, { key: String(n), code: `Digit${n}`, metaKey: true });
/** The desktop shell, told apart by the bridge its preload puts on the page. */
const asDesktopShell = (): (() => void) => {
  window.wsp = {};
  return () => delete window.wsp;
};
/** The chord a palette row shows, by the row's title; a title also appears as another row's description, so match the title span. */
const chordOn = (title: string): string | null => {
  const rows = [...(palette()?.querySelectorAll<HTMLElement>("[data-slot=command-item]") ?? [])];
  const row = rows.find(candidate => candidate.querySelector("span.truncate")?.textContent === title);
  if (row === undefined) throw new Error(`no palette row titled ${title}`);
  return row.querySelector("[data-slot=command-shortcut]")?.textContent ?? null;
};

/** The meta line under a palette row's title, by that title. */
const metaOn = (title: string): string | null => {
  const rows = [...(palette()?.querySelectorAll<HTMLElement>("[data-slot=command-item]") ?? [])];
  const row = rows.find(candidate => candidate.querySelector("span.truncate")?.textContent === title);
  if (row === undefined) throw new Error(`no palette row titled ${title}`);
  return row.querySelector("span.text-muted-foreground\\/70")?.textContent ?? null;
};

/** The caret asks for one workspace from this call on; one left pending by an earlier test is dropped. */
const watchComposerFocus = (workspaceId: string): { asks: string[]; off: () => void } => {
  const asks: string[] = [];
  const off = onComposerFocusRequest(workspaceId, () => asks.push(workspaceId));
  asks.length = 0;
  return { asks, off };
};

const palette = () => document.querySelector<HTMLElement>("[data-command-palette]");
const inPalette = () => within(palette()!);
const tabbar = () => document.querySelector("[data-right-panel-tabbar]");
const sidebarState = () => document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state");
const panel = (id: string) => useRightPanelStore.getState().byWorkspaceId[id];
const drawer = (id: string) => useTerminalDrawerStore.getState().byWorkspaceId[id];
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));

// Shell render plus palette open and close: about 250 ms idle, under 1.5 s with eight CPU hogs; a saturated box has pushed the whole test past 5 s.
// Every waitFor in the file shares the 10 s ceiling too, else one wait trips at the library's 1 s default before the test budget applies.
vi.setConfig({ testTimeout: 15_000 });
configure({ asyncUtilTimeout: 10_000 });

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, creations: [], sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true }, settingsOpen: false });
  clearNotices();
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  provideTerminals("ws_a", null);
  provideTerminals("ws_b", null);
  // The switcher's hold outlives a render: a test that left the overlay up ate the next one's chord.
  cancelWorkspaceSwitch();
});

async function mountShell(sessions: SessionView[] = []) {
  const api = fakeApi([view("ws_a", "api"), view("ws_b", "worker")], sessions);
  useStore.getState().bind(api);
  render(
    <AppShell>
      <div>center content</div>
    </AppShell>,
  );
  // The shell opens on the sidebar's first row: ws_a with no sessions, the workspace of the latest one otherwise.
  await waitFor(() => expect(useStore.getState().selectedId).not.toBeNull());
  await waitFor(() => expect(useStore.getState().workspaces.length).toBe(2));
  return api;
}

describe("command palette", () => {
  it("opens on mod+k, lists actions, workspaces and threads, and closes on mod+k again", async () => {
    await mountShell([session("s1", "ws_b", "fix the flaky test")]);
    expect(palette()).toBeNull();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(inPalette().getByText("Toggle right panel")).toBeTruthy();
    expect(inPalette().getAllByText("worker").length).toBeGreaterThan(0);
    expect(inPalette().getByText("fix the flaky test")).toBeTruthy();
    mod("k");
    await waitFor(() => expect(palette()).toBeNull());
  });

  it("a workspace row reads its state and where it runs, never the id wsp holds its machine under", async () => {
    useStore.getState().bind(fakeApi([view("ws_a", "api", "running", { provider: "solari" }), view("ws_b", "worker", "napping")], []));
    render(
      <AppShell>
        <div>center content</div>
      </AppShell>,
    );
    await waitFor(() => expect(useStore.getState().workspaces.length).toBe(2));
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    // The provider its own record names, and, on a record that names none, what the machine is: a person picks a
    // workspace by its state and where it runs, and the id the provider minted for the machine names neither.
    expect(metaOn("api")).toBe("Running on solari");
    expect(metaOn("worker")).toBe("Stopped on a provider");
    // The open workspace says so at the row's right edge, apart from the facts under its title.
    expect(within(palette()!).getAllByText("Current task")).toHaveLength(1);
    for (const title of ["api", "worker"]) expect(metaOn(title)).not.toMatch(/m_ws_/);
  });

  it("reads this computer's own daemon in the row and in the rebuild's reason, and never says Unreachable about it", async () => {
    const here: WorkspaceView = { ...view("ws_a", "mac"), kind: "local", machineId: "local" };
    const api = fakeApi([here], []);
    api.watchStatuses = async () => [{ ...here, machineState: "running", reach: { state: "unreachable" }, size: { cpu: 8, memMb: 16384 }, kind: "local" } as unknown as WorkspaceStatus];
    useStore.getState().bind(api);
    render(
      <AppShell>
        <div>center content</div>
      </AppShell>,
    );
    await waitFor(() => expect(Object.keys(useStore.getState().statuses)).toHaveLength(1));
    await waitFor(() => expect(useStore.getState().selectedId).toBe(here.id));
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    await waitFor(() => expect(metaOn("mac")).toContain("No daemon"));
    expect(metaOn("mac")).not.toContain("Unreachable");
    // The rebuild forks a machine again from the image, and there is no machine of wsp's here to fork, so the
    // palette offers no such row at all rather than one held with a reason nobody can clear.
    fireEvent.change(screen.getByPlaceholderText(/Search commands/), { target: { value: "rebuild" } });
    await waitFor(() => expect(palette()!.textContent).not.toContain(WORKSPACE_WORDS.rebuild));
    // No row of the list says unreachable about the computer the app is drawn on, whichever verb it refuses.
    for (const query of ["browser", "forget", ""]) {
      fireEvent.change(screen.getByPlaceholderText(/Search commands/), { target: { value: query } });
      await waitFor(() => expect(palette()!.textContent).not.toContain("unreachable"));
      expect(palette()!.textContent).not.toContain("Unreachable");
    }
  });

  it("offers the start the row's own line names, under start and under daemon, and refuses it while the daemon answers", async () => {
    const here: WorkspaceView = { ...view("ws_a", "mac"), kind: "local", machineId: "local" };
    const asked: string[] = [];
    const api = fakeApi([here], []);
    api.restartDaemon = async (id: string) => void asked.push(id);
    api.watchStatuses = async () => [{ ...here, machineState: "running", reach: { state: "unreachable" }, size: { cpu: 8, memMb: 16384 }, kind: "local" } as unknown as WorkspaceStatus];
    useStore.getState().bind(api);
    render(
      <AppShell>
        <div>center content</div>
      </AppShell>,
    );
    await waitFor(() => expect(Object.keys(useStore.getState().statuses)).toHaveLength(1));
    await waitFor(() => expect(useStore.getState().selectedId).toBe(here.id));
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    // The row's third line reads start it, and the word a person types to find it is either half of that.
    for (const query of ["start", "daemon"]) {
      fireEvent.change(screen.getByPlaceholderText(/Search commands/), { target: { value: query } });
      await waitFor(() => expect(palette()!.textContent).toContain(WORKSPACE_WORDS.startDaemon));
    }
    await act(async () => void fireEvent.click(within(palette()!).getByText(WORKSPACE_WORDS.startDaemon)));
    expect(asked).toEqual([here.id]);
  });

  it("offers no start on a workspace whose daemon this host does not hold: the row is absent, not dimmed", async () => {
    await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText(/Search commands/), { target: { value: "start the daemon" } });
    await waitFor(() => expect(palette()!.textContent).not.toContain(WORKSPACE_WORDS.startDaemon));
  });

  it("carries Add a computer, which opens Settings with the sheet over it", async () => {
    await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.click(inPalette().getByText(PLACES_WORDS.addComputer));
    await waitFor(() => expect(palette()).toBeNull());
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useStore.getState().addComputerOpen).toBe(true);
  });

  it("carries Add a project, which opens the sheet the sidebar's own row opens, and no cloud to connect", async () => {
    await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    // The provider noun has left the app: there is no row for it and nothing about it to find.
    expect(inPalette().queryByText(PLACES_WORDS.connectProvider)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/Search commands/), { target: { value: "provider" } });
    await waitFor(() => expect(inPalette().queryByText(PLACES_WORDS.addComputer)).toBeNull());
    fireEvent.change(screen.getByPlaceholderText(/Search commands/), { target: { value: "" } });
    fireEvent.click(inPalette().getByText(PROJECT_WORDS.add));
    await waitFor(() => expect(palette()).toBeNull());
    await waitFor(() => expect(document.querySelector("[data-k='add-project']")).not.toBeNull());
  });

  it("filters by query and switches workspace from a row", async () => {
    await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText(/Search commands/), { target: { value: "work" } });
    await waitFor(() => expect(inPalette().queryByText("Toggle sidebar")).toBeNull());
    fireEvent.click(inPalette().getByText("worker"));
    await waitFor(() => expect(palette()).toBeNull());
    expect(useStore.getState().selectedId).toBe("ws_b");
  });

  it("runs an action: pausing the selected workspace calls nap", async () => {
    const api = await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText(/Search commands/), { target: { value: ">pause" } });
    fireEvent.click(await screen.findByText("Pause task"));
    await waitFor(() => expect(api.nap).toHaveBeenCalledWith("ws_a"));
    expect(palette()).toBeNull();
  });


  it("the Settings row and its chord open the settings page, whose row names the chord; the settings sidebar's Back closes it again", async () => {
    // No flag over the page: the row stands for everybody.
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false } });
    await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    const row = inPalette().getByText("Settings", { selector: "[data-slot=command-item] span" }).closest("[data-slot=command-item]")!;
    expect(row.textContent).toContain("⌘,");
    fireEvent.click(row);
    await waitFor(() => expect(palette()).toBeNull());
    expect(useStore.getState().settingsOpen).toBe(true);
    // The settings sidebar stands in the app sidebar's place while the page is open, so Back is the row that closes it.
    expect(document.querySelector("[data-row-id='ws:ws_b']")).toBeNull();
    fireEvent.click(document.querySelector("[data-k=settings-back]")!);
    expect(useStore.getState().settingsOpen).toBe(false);
    mod(",");
    expect(useStore.getState().settingsOpen).toBe(true);
    // The chord toggles and Escape closes, so a host with no workspace row to pick can still leave the page.
    mod(",");
    expect(useStore.getState().settingsOpen).toBe(false);
    mod(",");
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  it("opens the new-workspace dialog through the sidebar", async () => {
    await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.click(screen.getByText("New task", { selector: "[data-slot=command-item] span" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "New task" })).toBeTruthy());
  });

  it("while a creation row is selected, the shortcuts act on no workspace: no thread request, no drawer, no panel", async () => {
    await mountShell();
    const seen: string[] = [];
    const off = onNewThreadRequest(d => seen.push(d.workspaceId));
    act(() => useStore.setState({ creations: [{ key: "creating:1", name: "beta", askedAt: Date.now(), workspaceId: null, lines: [], failed: null }], selectedId: "creating:1" }));
    mod("n");
    mod("j");
    mod("b", { altKey: true });
    await settle();
    expect(seen).toEqual([]);
    expect(drawer("creating:1")).toBeUndefined();
    expect(panel("creating:1")).toBeUndefined();
    off();
  });

  it("raises a new-thread request for the selected workspace", async () => {
    await mountShell();
    const seen: string[] = [];
    const off = onNewThreadRequest(d => seen.push(d.workspaceId));
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.click(screen.getByText("New thread"));
    expect(seen).toEqual(["ws_a"]);
    off();
  });

  it("the sidebar's search row is the palette's door: focus alone opens nothing, a click opens it, Escape shuts it and it stays shut", async () => {
    await mountShell();
    const row = screen.getByRole("button", { name: "Search" });
    act(() => row.focus());
    await settle();
    expect(palette()).toBeNull();
    expect(document.activeElement).toBe(row);
    fireEvent.click(row);
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(document.querySelector("[data-slot=sidebar] input")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" });
    await waitFor(() => expect(palette()).toBeNull());
    await settle();
    expect(palette()).toBeNull();
  });

  it("a typed title finds a thread beyond the recent cap and opens that thread; workspaces narrow by name alone", async () => {
    const recent = Array.from({ length: RECENT_THREAD_LIMIT }, (_, i) => ({ ...session(`s${i}`, "ws_a", `recent task ${i}`), threadId: `t${i}`, startedAt: Date.now() - i * 1_000 }));
    const old = { ...session("s_old", "ws_b", "Archive the old logs"), threadId: "t_old", startedAt: Date.now() - 3_600_000 };
    await mountShell([...recent, old]);
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(inPalette().getByText("recent task 0")).toBeTruthy();
    expect(inPalette().queryByText("Archive the old logs")).toBeNull();
    const input = screen.getByPlaceholderText(/Search commands/);
    fireEvent.change(input, { target: { value: "archive" } });
    await waitFor(() => expect(inPalette().getByText("Archive the old logs")).toBeTruthy());
    expect(inPalette().queryByText("recent task 0")).toBeNull();
    // A workspace's name finds the workspace and not its threads; its machine id and state find nothing.
    fireEvent.change(input, { target: { value: "worker" } });
    await waitFor(() => expect(inPalette().getAllByText("worker")).toHaveLength(1));
    expect(inPalette().queryByText("Archive the old logs")).toBeNull();
    fireEvent.change(input, { target: { value: "m_ws_b" } });
    await waitFor(() => expect(inPalette().queryByText("worker")).toBeNull());
    fireEvent.change(input, { target: { value: "running" } });
    await waitFor(() => expect(inPalette().queryByText("worker")).toBeNull());
    fireEvent.change(input, { target: { value: "old logs" } });
    fireEvent.click(await inPalette().findByText("Archive the old logs"));
    await waitFor(() => expect(palette()).toBeNull());
    expect(useStore.getState().selectedId).toBe("ws_b");
    expect(useStore.getState().selectedThreadId).toBe("t_old");
  });

  it("lists a thread an agent opened on another workspace once, naming the workspace it runs on and where that runs", async () => {
    const lead = { ...session("s_lead", "ws_a", "run the migration across the fleet"), threadId: "t_lead", startedAt: Date.now() - 60_000 };
    // Opened by the lead's agent, filed under the other workspace: the palette reads the same tree the sidebar draws.
    const child = { ...session("s_child", "ws_b", "migration on worker"), threadId: "t_child", parentThreadId: "t_lead", startedBy: "agent" as const, startedAt: Date.now() - 30_000 };
    await mountShell([lead, child]);
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    const input = screen.getByPlaceholderText(/Search commands/);
    fireEvent.change(input, { target: { value: "migration" } });
    await waitFor(() => expect(inPalette().getByText("migration on worker")).toBeTruthy());
    // Once, not twice: the tree moves the row into its opener's group and never leaves a copy where it runs.
    const titles = [...palette()!.querySelectorAll<HTMLElement>("[data-slot=command-item] span.truncate")].map(node => node.textContent);
    expect(titles.filter(title => title === "migration on worker")).toHaveLength(1);
    expect(titles).toContain("run the migration across the fleet");
    // The workspace it runs on and where that runs, which is what tells it from a thread of the opener's own. This
    // fixture's records name no provider, so where it runs is what the machine is.
    const row = inPalette().getByText("migration on worker").closest<HTMLElement>("[data-slot=command-item]")!;
    expect(within(row).getByText("worker on a provider")).toBeTruthy();
  });

  it("a thread the sidebar has folded into its archive is still found by title and still opens", async () => {
    const fresh = { ...session("s_fresh", "ws_a", "tail the dev server"), threadId: "t_fresh", startedAt: Date.now() - 60_000 };
    // Quiet for a week, so the sidebar draws it inside a shut Archived group; the palette reads every thread the
    // workspace carries, not the rows the sidebar happens to be drawing.
    const buried = { ...session("s_buried", "ws_b", "rotate the daemon token"), threadId: "t_buried", startedAt: Date.now() - 8 * 24 * 60 * 60_000, endedAt: Date.now() - 7 * 24 * 60 * 60_000 };
    await mountShell([fresh, buried]);
    expect(document.querySelector("[data-row-id='archived:ws_b']")).not.toBeNull();
    expect(screen.queryByText("rotate the daemon token")).toBeNull();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    const input = screen.getByPlaceholderText(/Search commands/);
    fireEvent.change(input, { target: { value: "daemon token" } });
    fireEvent.click(await inPalette().findByText("rotate the daemon token"));
    await waitFor(() => expect(palette()).toBeNull());
    expect(useStore.getState().selectedId).toBe("ws_b");
    expect(useStore.getState().selectedThreadId).toBe("t_buried");
  });

  it("lists the switch with its chord and each workspace row with its slot chord, and in a browser tab only what one leaves the page", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      mod("k");
      await waitFor(() => expect(palette()).not.toBeNull());
      expect(chordOn("Next task")).toBe("⌃Tab");
      expect(chordOn("Previous task")).toBe("⌃⇧Tab");
      expect(chordOn("api")).toBe("⌘1");
      expect(chordOn("worker")).toBe("⌘2");
    } finally {
      restore();
    }
    mod("k");
    await waitFor(() => expect(palette()).toBeNull());
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    // A browser tab on macOS keeps Tab, the digits and the mod arrows for its own tabs, so the switch has no
    // chord to show there at all and the row is a click alone.
    expect(chordOn("Next task")).toBeNull();
    expect(chordOn("Previous task")).toBeNull();
    expect(chordOn("api")).toBeNull();
  });

  it("switches workspace from the Next workspace row and lands in that composer", async () => {
    await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    const { asks, off } = watchComposerFocus("ws_b");
    fireEvent.click(inPalette().getByText("Next task"));
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
    expect(asks).toEqual(["ws_b"]);
    off();
  });

  it("opens from a focused terminal on macOS, where Command is never the shell's", async () => {
    await mountShell();
    const term = document.createElement("div");
    term.dataset["terminalOwner"] = "drawer";
    const ta = document.createElement("textarea");
    term.appendChild(ta);
    document.body.appendChild(term);
    ta.focus();
    mod("k", {}, ta);
    await waitFor(() => expect(palette()).not.toBeNull());
    term.remove();
  });

  it("stays shut from a focused terminal where mod is Control, which the shell reads", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await mountShell();
    const term = document.createElement("div");
    term.dataset["terminalOwner"] = "drawer";
    const ta = document.createElement("textarea");
    term.appendChild(ta);
    document.body.appendChild(term);
    ta.focus();
    fireEvent.keyDown(ta, { key: "k", code: "KeyK", ctrlKey: true });
    await settle();
    expect(palette()).toBeNull();
    term.remove();
  });
});

describe("default shortcuts", () => {
  it("mod+b toggles the sidebar", async () => {
    await mountShell();
    expect(sidebarState()).toBe("expanded");
    mod("b");
    await waitFor(() => expect(sidebarState()).toBe("collapsed"));
  });

  it("mod+alt+b toggles the right panel and the header tooltip names it", async () => {
    await mountShell();
    expect(tabbar()).not.toBeNull();
    fireEvent.keyDown(window, { key: "∫", code: "KeyB", metaKey: true, altKey: true });
    await waitFor(() => expect(tabbar()).toBeNull());
    expect(panel("ws_a")?.isOpen).toBe(false);
  });

  it("mod+shift+j toggles the browser surface", async () => {
    await mountShell();
    mod("j", { shiftKey: true });
    await waitFor(() => expect(panel("ws_a")?.activeSurfaceId).toBe("browser:new"));
    mod("j", { shiftKey: true });
    await waitFor(() => expect(panel("ws_a")?.isOpen).toBe(false));
  });

  it("mod+j toggles the terminal drawer and never touches the right panel", async () => {
    await mountShell();
    provideTerminals("ws_a", fakeTerminals());
    mod("j");
    await waitFor(() => expect(drawer("ws_a")?.terminalOpen).toBe(true));
    mod("j");
    await waitFor(() => expect(drawer("ws_a")?.terminalOpen ?? false).toBe(false));
    expect(panel("ws_a")?.surfaces.filter(s => s.kind === "terminal") ?? []).toEqual([]);
  });

  it("mod+d splits and mod+n opens a drawer terminal only while the terminal has focus", async () => {
    await mountShell();
    provideTerminals("ws_a", fakeTerminals());
    mod("d");
    await settle();
    expect(drawer("ws_a")).toBeUndefined();

    const term = document.createElement("div");
    term.dataset["terminalOwner"] = "drawer";
    const ta = document.createElement("textarea");
    term.appendChild(ta);
    document.body.appendChild(term);
    ta.focus();
    mod("n", {}, ta);
    await waitFor(() => expect(drawer("ws_a")?.terminalIds).toEqual(["pty1"]));
    expect(drawer("ws_a")?.terminalOpen).toBe(true);
    mod("d", {}, ta);
    await waitFor(() => expect(drawer("ws_a")?.terminalGroups.map(g => g.terminalIds)).toEqual([["pty1", "pty2"]]));
    mod("n", {}, ta);
    await waitFor(() => expect(drawer("ws_a")?.terminalGroups.map(g => g.terminalIds)).toEqual([["pty1", "pty2"], ["pty3"]]));
    expect(panel("ws_a")?.surfaces.filter(s => s.kind === "terminal") ?? []).toEqual([]);
    term.remove();
  });

  it("mod+d and mod+n act on the right panel's terminal while one of its terminals has focus", async () => {
    await mountShell();
    const terms = fakeTerminals();
    provideTerminals("ws_a", terms);
    const tab = await terms.open();
    act(() => useRightPanelStore.getState().openTerminal("ws_a", tab.ptyId));
    await waitFor(() => expect(panel("ws_a")?.activeSurfaceId).toBe("terminal:pty1"));

    const term = document.createElement("div");
    term.dataset["terminalOwner"] = "right-panel";
    const ta = document.createElement("textarea");
    term.appendChild(ta);
    document.body.appendChild(term);
    ta.focus();
    mod("d", {}, ta);
    await waitFor(() => {
      const surface = panel("ws_a")?.surfaces[0];
      expect(surface?.kind === "terminal" && surface.terminalIds).toEqual(["pty1", "pty2"]);
    });
    mod("n", {}, ta);
    await waitFor(() => expect(panel("ws_a")?.activeSurfaceId).toBe("terminal:pty3"));
    expect(drawer("ws_a")).toBeUndefined();
    term.remove();
  });

  it("a ctrl+tab tap walks the sidebar's workspaces and wraps, and ctrl+shift+tab walks back", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      expect(useStore.getState().selectedId).toBe("ws_a");
      ctrlTab();
      ctrlUp();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
      ctrlTab();
      ctrlUp();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
      ctrlTab({ shiftKey: true });
      ctrlUp();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
    } finally {
      restore();
    }
  });

  it("mod and a digit jump to that sidebar row, and ask its composer for the caret", async () => {
    await mountShell();
    const restore = asDesktopShell();
    const { asks, off } = watchComposerFocus("ws_b");
    try {
      digit(2);
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
      expect(asks).toEqual(["ws_b"]);
      digit(3);
      await settle();
      expect(useStore.getState().selectedId).toBe("ws_b");
      digit(1);
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
    } finally {
      off();
      restore();
    }
  });

  it("in a browser tab the switch chords belong to the browser and move nothing", async () => {
    await mountShell();
    ctrlTab();
    ctrlUp();
    ctrlTab({ shiftKey: true });
    ctrlUp();
    digit(2);
    await settle();
    expect(useStore.getState().selectedId).toBe("ws_a");
  });

  it("the mod arrows walk the workspaces in either body, and a browser tab on macOS keeps them for its own tabs", async () => {
    await mountShell();
    const restore = asDesktopShell();
    try {
      expect(useStore.getState().selectedId).toBe("ws_a");
      spaceArrow("ArrowRight");
      spaceArrowUp();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
      spaceArrow("ArrowLeft");
      spaceArrowUp();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
      act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, sidebarMode: "spaces" } }));
      spaceArrow("ArrowRight");
      spaceArrowUp();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
    } finally {
      restore();
    }
    spaceArrow("ArrowLeft");
    spaceArrowUp();
    await settle();
    expect(useStore.getState().selectedId).toBe("ws_b");
  });


  it("in the list the Tab pair is still the workspace switch, and it never moves a thread", async () => {
    await mountShell([session("s1", "ws_a", "fix the port list", { threadId: "thr_1" }), session("s2", "ws_a", "bump the lockfile", { threadId: "thr_2" })]);
    const restore = asDesktopShell();
    try {
      useStore.getState().select("ws_a");
      ctrlTab();
      ctrlUp();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
      expect(useStore.getState().selectedThreadId).toBeNull();
    } finally {
      restore();
    }
  });

  it("a space with one thread the walk can land on has nowhere to go, and the palette's rows say so", async () => {
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, sidebarMode: "spaces" } }));
    await mountShell([session("s1", "ws_a", "fix the port list", { threadId: "thr_1" }), session("s2", "ws_a", "no id on this row")]);
    const restore = asDesktopShell();
    try {
      useStore.getState().select("ws_a", "thr_1");
      ctrlTab();
      await settle();
      expect(useStore.getState().selectedThreadId).toBe("thr_1");
      mod("k");
      await waitFor(() => expect(palette()).not.toBeNull());
      // Both directions say it, since neither has anywhere to go.
      expect(inPalette().getAllByText("Only one thread")).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it("a held Next thread over a list of threads names the workspace its walk is in and says the listed ones are not in it", async () => {
    const onWorker = [1, 2, 3, 4].map(n => session(`s${n}`, "ws_b", `worker job ${n}`, { threadId: `thr_${n}` }));
    await mountShell(onWorker);
    const restore = asDesktopShell();
    try {
      // api is on screen and has no thread of its own; the four under the palette's own list all run on worker.
      useStore.getState().select("ws_a");
      await settle();
      mod("k");
      await waitFor(() => expect(palette()).not.toBeNull());
      for (const row of onWorker) expect(inPalette().getByText(row.prompt!)).toBeTruthy();
      // Both directions, since neither can step. "No threads to walk" over four listed threads is what stopped a
      // tester believing the app about its own state.
      expect(inPalette().queryByText("No threads to walk")).toBeNull();
      expect(inPalette().getAllByText("Nothing to step to on api; a walk stays inside one task")).toHaveLength(2);
      // And the walk does hold them once the workspace they run on is the one on screen.
      mod("k");
      await waitFor(() => expect(palette()).toBeNull());
      useStore.getState().select("ws_b");
      await settle();
      mod("k");
      await waitFor(() => expect(palette()).not.toBeNull());
      expect(inPalette().queryByText(/Nothing to step to/)).toBeNull();
      // The mod arrows walk the threads of the workspace on screen, as left and right walk the workspaces.
      expect(chordOn("Next thread")).toBe("⌥⌘Down");
    } finally {
      restore();
    }
  });

  it("lists the workspace walk with the Tab pair and the thread walk with the arrows under it", async () => {
    const sessions = [session("s1", "ws_a", "fix the port list", { threadId: "thr_1" }), session("s2", "ws_a", "bump the lockfile", { threadId: "thr_2" })];
    await mountShell(sessions);
    const restore = asDesktopShell();
    try {
      useStore.getState().select("ws_a");
      mod("k");
      await waitFor(() => expect(palette()).not.toBeNull());
      expect(chordOn("Next thread")).toBe("⌥⌘Down");
      expect(chordOn("Previous thread")).toBe("⌥⌘Up");
      expect(chordOn("Next task")).toBe("⌃Tab");
      expect(chordOn("Previous task")).toBe("⌃⇧Tab");
    } finally {
      restore();
    }
  });

  it("the palette's Next thread row moves the same walk the chord does", async () => {
    await mountShell([session("s1", "ws_a", "fix the port list", { threadId: "thr_1" }), session("s2", "ws_a", "bump the lockfile", { threadId: "thr_2" })]);
    useStore.getState().select("ws_a");
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.click(inPalette().getByText("Next thread"));
    await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("thr_1"));
  });

  it("leaves a pty it could not open to the pane the click was in, and puts nothing in the sidebar's corner", async () => {
    // The link's own words used to land in the foot of the sidebar behind a workspace name and a colon, in the
    // opposite corner from the click, where nothing cleared them; the pane a person clicked says it instead.
    await mountShell();
    const term = document.createElement("div");
    term.dataset["terminalOwner"] = "drawer";
    const ta = document.createElement("textarea");
    term.appendChild(ta);
    document.body.appendChild(term);
    ta.focus();
    mod("n", {}, ta);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(lastNotice()).toBeNull();
    term.remove();
  });
});

describe("stepInOrder", () => {
  const ids = ["ws_a", "ws_b", "ws_c"];

  it("wraps at both ends, and starts from the near end while the selected row is no workspace", () => {
    expect(stepInOrder(ids, "ws_a", 1)).toBe("ws_b");
    expect(stepInOrder(ids, "ws_c", 1)).toBe("ws_a");
    expect(stepInOrder(ids, "ws_a", -1)).toBe("ws_c");
    expect(stepInOrder(ids, null, 1)).toBe("ws_a");
    expect(stepInOrder(ids, null, -1)).toBe("ws_c");
    expect(stepInOrder(ids, "creating:1", 1)).toBe("ws_a");
    expect(stepInOrder([], null, 1)).toBeNull();
  });

  it("answers nowhere to go for the one workspace already selected, which is what the palette's rows say", () => {
    expect(stepInOrder(["ws_a"], "ws_a", 1)).toBeNull();
    expect(stepInOrder(["ws_a"], "ws_a", -1)).toBeNull();
    expect(stepInOrder(["ws_a"], "creating:1", 1)).toBe("ws_a");
  });
});

describe("typing contexts", () => {
  const rules = compileResolvedKeybindingsConfig([
    { key: "b", command: "sidebar.toggle" },
    { key: "mod+b", command: "sidebar.toggle" },
  ]);

  function SidebarOpenProbe() {
    return <span data-testid="sidebar-open">{String(useSidebar().open)}</span>;
  }

  function mountDispatcher() {
    render(
      <SidebarProvider defaultOpen>
        <KeybindingDispatcher keybindings={rules} />
        <SidebarOpenProbe />
        <input aria-label="probe" />
      </SidebarProvider>,
    );
  }
  const sidebarOpen = () => screen.getByTestId("sidebar-open").textContent;

  it("ignores a bare key typed into an input but honours the same key chorded", async () => {
    mountDispatcher();
    const input = screen.getByLabelText("probe");
    input.focus();
    fireEvent.keyDown(input, { key: "b", code: "KeyB" });
    await settle();
    expect(sidebarOpen()).toBe("true");
    fireEvent.keyDown(input, { key: "b", code: "KeyB", metaKey: true });
    await waitFor(() => expect(sidebarOpen()).toBe("false"));
  });

  it("fires a bare key outside a typing context", async () => {
    mountDispatcher();
    fireEvent.keyDown(window, { key: "b", code: "KeyB" });
    await waitFor(() => expect(sidebarOpen()).toBe("false"));
  });

  it("switches twice in a row from inside a text field, where a bare option arrow is still that field's word move", async () => {
    await mountShell();
    const restore = asDesktopShell();
    const box = document.createElement("textarea");
    document.body.appendChild(box);
    box.focus();
    try {
      // The row this walk starts from is named rather than inherited: the workspace a load opens on is the one this
      // browser had open last, so a test that assumed the first row read the row another test left behind.
      useStore.getState().select("ws_a");
      await settle();
      // The composer takes the caret after every switch, so the second press of the chord is the one that proves it.
      spaceArrow("ArrowRight", box);
      spaceArrowUp();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_b"));
      spaceArrow("ArrowRight", box);
      spaceArrowUp();
      await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
      fireEvent.keyDown(box, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
      fireEvent.keyUp(window, { key: "Alt" });
      await settle();
      expect(useStore.getState().selectedId).toBe("ws_a");
    } finally {
      box.remove();
      restore();
    }
  });

  it("holds the rows of the four nouns with no flag over any of them, and no Spaces row among them", async () => {
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false } });
    await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    const titles = Array.from(palette()!.querySelectorAll("[data-slot=command-item] span")).map(el => el.textContent ?? "");
    for (const said of [NEW_WORKSPACE, PROJECT_WORDS.add, PLACES_WORDS.addComputer, "Settings", "Toggle right panel"]) {
      expect(titles).toContain(said);
    }
    expect(titles.some(t => /Spaces/.test(t) || t === PLACES_WORDS.connectProvider)).toBe(false);
  });
});
