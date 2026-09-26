// SPDX-License-Identifier: AGPL-3.0-only
// The workspace sidebar over the fixture wire: rows from the store's
// workspaces, statuses, costs and sessions; grouping; search; keyboard
// traversal; the new-workspace dialog; the zombie rebuild and the gone forget.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, createContext, useContext, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_UPDATE_FAILED, DAEMON_UPDATING, DEFAULT_PREFERENCES, DEFAULT_THEME, FREE_WORD, HOSTNAME_KEPT, HOST_ASLEEP_LINE, PROVIDER_UNREACHED_LINE, exportFromLine, harmonyDots, importIntoLine, registeredLine, type PlaceView, type ProjectView, type SessionView, type WorkspaceLook, type WorkspaceStatus, type WorkspaceTheme, type WorkspaceView } from "@wsp/protocol";
import { WORKSPACE_WORDS } from "../src/actions/format.js";
import { onOpenCommandPalette } from "../src/commandPaletteBus.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { getLive, resetLive } from "../src/machine/live.js";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { SETTINGS_WORDS } from "../src/settings/format.js";
import { placeName } from "../src/settings/places.js";
import { statusOf } from "./workspace-status.js";
import { onNewThreadRequest, requestNewWorkspace, requestProjectTrip, requestRenameWorkspace } from "../src/shell/shellRequests.js";
import { WorkspaceSidebar } from "../src/sidebar/WorkspaceSidebar.js";
import { NEW_WORKSPACE, PROJECT_WORDS, SWITCHER_WORDS } from "../src/sidebar/words.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { WorkspaceTerminals, provideTerminals } from "../src/terminal/link.js";
import { clearNotices, lastNotice } from "./notice-text.js";

// The triggers keep their elements, and no popup mounts: this file focuses and
// clicks the search row, and Base UI's positioning against jsdom's zero-size
// rects costs seconds per open. The tooltip's own text is covered in
// search-row.test.tsx, where the popup renders inline.
vi.mock("../src/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) =>
    element === undefined ? <>{children}</> : cloneElement(element, {}, children ?? element.props.children),
  TooltipPopup: () => null,
}));

// The switcher's menu on a plain open/closed context: Base UI's popover never settles under jsdom. The trigger
// keeps its element and its props, so the head is the real row.
vi.mock("../src/components/ui/popover.js", () => {
  const Ctx = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Popover = ({ children, open, onOpenChange }: { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) => <Ctx.Provider value={{ open, set: onOpenChange }}>{children}</Ctx.Provider>;
  const PopoverTrigger = ({ children, render: element, disabled, ...props }: { children: ReactNode; render: ReactElement<Record<string, unknown>>; disabled?: boolean; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    return cloneElement(element, { ...props, disabled, onClick: () => ctx.set(!ctx.open) }, children);
  };
  const PopoverPopup = ({ children }: { children: ReactNode }) => (useContext(Ctx).open ? <div role="dialog" data-slot="popover-popup">{children}</div> : null);
  return { Popover, PopoverTrigger, PopoverPopup };
});

const NOW = Date.now();
const iso = (offsetMs: number) => NOW + offsetMs;

// The rows stand in the order the workspaces were made, so a test that reads the list by position says how long
// ago each of its own was; an hour is the default, and workspaces sharing it fall to their ids.
const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running", createdAgoMs = 60 * 60_000): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase,
  golden: "snap_g",
  createdAt: new Date(NOW - createdAgoMs).toISOString(),
});

const status = statusOf;

const session = (id: string, workspaceId: string, over: Partial<SessionView> = {}): SessionView => ({
  id,
  workspaceId,
  harness: "claude",
  status: "running",
  ...over,
});

type FakeApi = Api & {
  createWorkspace: ReturnType<typeof vi.fn>;
  rebuild: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
  watchStatuses: ReturnType<typeof vi.fn>;
};

function fakeApi(workspaces: WorkspaceView[], statuses: WorkspaceStatus[], sessions: SessionView[] = []): FakeApi {
  return {
    listWorkspaces: vi.fn(async () => workspaces),
    // Two rows: this computer, which is never somewhere to put a workspace, and the provider this host forks on,
    // which is the row the New workspace dialog checks.
    placesList: vi.fn(async () => ({ places: PLACES, adds: [] })),
    projectsList: vi.fn(async () => PROJECTS),
    getWorkspace: vi.fn(async id => workspaces.find(w => w.id === id)!),
    createWorkspace: vi.fn(async (_project: string, name: string) => view("ws_new", name)),
    watchStatuses: vi.fn(async () => statuses),
    nap: vi.fn(async (id: string) => view(id, "?", "napping")),
    wake: vi.fn(async (id: string) => view(id, "?", "running")),
    rebuild: vi.fn(async (id: string) => ({ ...view(id, "?", "running"), machineId: "m_rebuilt" })),
    forget: vi.fn(async (_id: string) => {}),
    capabilities: vi.fn(async () => (caps())),
    startSession: vi.fn(async (o: { workspaceId: string }) => session("s_x", o.workspaceId)),
    portReach: vi.fn(async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: NOW + 3_600_000 })),
    daemon: noDaemonApi,
    sessionHistory: vi.fn(async () => []),
    listSnapshots: vi.fn(async () => ({ name: "default", head: null, versions: [] })),
    snapshotStorage: async () => null,
    rollbackSnapshot: vi.fn(async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" as const })),
    listSessions: vi.fn(async () => sessions),
    subscribe: vi.fn(() => () => {}),
    // The rows here are forks of a golden, so one is sealed; first-run.test.tsx covers the sidebar with none.
    getGolden: async () => ({ head: 1, versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "t", setupSha: "s", createdAt: "c", smoke: { cmd: "true", exitCode: 0 } }] }),
    // The look sits on the record beside the name, so the fixture writes it there and answers with the row.
    setWorkspaceLook: vi.fn(async (id: string, look: WorkspaceLook) => {
      const row = workspaces.find(w => w.id === id)!;
      if (look.theme !== undefined) {
        if (look.theme === null) delete row.theme;
        else row.theme = look.theme;
      }
      if (look.glyph !== undefined) {
        if (look.glyph === null) delete row.glyph;
        else row.glyph = look.glyph;
      }
      return row;
    }),
  };
}

const PLACES: PlaceView[] = [
  { id: "here", kind: "computer", name: "studio.local", default: false, engine: "none", present: true, takesForks: false },
  { id: "box", kind: "provider", name: "box", default: true, rateUsdPerHour: 0.018, takesForks: true },
];
/** What the dialog makes a workspace of: one project on the computer these tests fork at. */
const PROJECTS: ProjectView[] = [
  { id: "pr_1", name: "spoo-landing", computer: "box", source: { kind: "git", url: "https://github.com/dev/spoo.git" }, path: "/root/spoo-landing", remote: "https://github.com/dev/spoo.git", defaultBranch: "main", memoryKey: "-root-spoo-landing", memoryDir: "/var/lib/wsp/projects/pr_1/memory", createdAt: "t" },
];
/** What a row calls the provider these tests fork at, through the one rule every surface names a computer by. */
const BOX_NAME = placeName(PLACES[1]!);
/** A second project, on this computer, for the cases about the switcher and the tree over two projects. */
const HERE_PROJECT: ProjectView = { id: "pr_2", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/dev/wsp" }, path: "/Users/dev/wsp", remote: "https://github.com/dev/wsp.git", defaultBranch: "main", memoryKey: "-Users-dev-wsp", memoryDir: "/Users/dev/.claude-cfg/projects/-Users-dev-wsp/memory", createdAt: "t" };

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ places: [], projects: [], placesRefused: null, projectsRefused: null, api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, selectedThreadId: null, projectHome: null, creations: [], sessions: {}, launches: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true }, settingsOpen: false });
  clearNotices();
});

async function mount(api: FakeApi, firstName: string) {
  useStore.getState().bind(api);
  render(
    <SidebarProvider defaultOpen>
      <WorkspaceSidebar />
    </SidebarProvider>,
  );
  await waitFor(() => expect(screen.getByText(firstName)).toBeDefined());
  return api;
}

const rowOf = (text: string): HTMLElement => screen.getByText(text).closest<HTMLElement>("[data-sidebar-row]")!;
const rowIds = () => Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-row]")).map(r => r.dataset["rowId"]);
const stateSlot = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>("[data-workspace-state]")!;
/** A thread row's state, which is one muted mono word and never a dot; null on a row that carries none. */
const threadState = (row: HTMLElement): string | null => row.querySelector<HTMLElement>("[data-thread-state]")?.textContent ?? null;
/** A thread row's time, which stands in the slot only once the thread rests; null while a state word holds it. */
const threadTime = (row: HTMLElement): string | null => row.querySelector<HTMLElement>("[data-thread-time]")?.textContent ?? null;
const depthOf = (row: HTMLElement): number => Number(row.dataset["depth"]);
const head = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("[data-k=project-switcher]")!;
const menu = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-project-switcher-menu]");
const metaOf = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>("[data-workspace-meta]")!;
const spaceHeader = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-space-header]");
const headerLines = (): string[] => Array.from(document.querySelectorAll<HTMLElement>("[data-space-header] [data-space-meta]")).map(l => l.textContent ?? "");
const icons = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>("[data-space-icon]"));
const panes = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>("[data-space-pane]"));
const paneNames = (): string[] => Array.from(document.querySelectorAll<HTMLElement>("[data-space-pane] [data-space-name]")).map(n => n.textContent ?? "");
/** What React says when one body is drawn as both panes: the one console line the reversal case is about. */
const DUPLICATE_KEY = "two children with the same key";
/** The name in the header of the body that is staying: the pane not marked as the one on its way out. */
const spaceName = (): string => document.querySelector<HTMLElement>("[data-space-pane]:not([data-space-leaving]) [data-space-name]")?.textContent ?? "";
const workspaceRowIds = (): string[] => Array.from(document.querySelectorAll<HTMLElement>("[data-row-id^='ws:']")).map(r => r.dataset["rowId"] ?? "");

const API = view("ws_a", "api");
const WEB = view("ws_b", "web", "napping");
/** The same workspace as a copy on a branch, which is what gives its row a second line. */
const COPIED = { ...API, copy: { road: "clonefile" as const, path: "/Users/dev/spoo-api", source: "/Users/dev/spoo", base: "abc", branch: "agent/api-port-list", carried: "deps-and-config" as const } };

describe("header", () => {
  it("carries the brand lockup named wsp", async () => {
    useStore.getState().bind(fakeApi([], []));
    await act(async () => {
      render(
        <SidebarProvider defaultOpen>
          <WorkspaceSidebar />
        </SidebarProvider>,
      );
    });
    expect(screen.getByRole("img", { name: "wsp" })).toBeTruthy();
  });

  it("the header row starts at the frame inset with the toggle, the lockup follows it, and the search row shares the content inset", async () => {
    useStore.getState().bind(fakeApi([], []));
    await act(async () => {
      render(
        <SidebarProvider defaultOpen>
          <WorkspaceSidebar />
        </SidebarProvider>,
      );
    });
    const lockup = screen.getByRole("img", { name: "wsp" });
    const row = lockup.parentElement!;
    expect(row.getAttribute("data-slot")).toBe("sidebar-header");
    expect(row.className).toContain("pl-[var(--header-frame-inset)]");
    expect(row.className).toContain("gap-[calc(var(--header-gap)-var(--workspace-titlebar-control-size)/2)]");
    expect(lockup.previousElementSibling!.getAttribute("data-slot")).toBe("sidebar-trigger");
    expect(screen.getByRole("button", { name: "Search" }).closest("[data-sidebar-search]")!.className).toContain("px-[var(--sidebar-content-inset)]");
  });
});

describe("rows from the fixture wire", () => {
  it("first level is the workspaces, second level their sessions titled by prompt with a relative time", async () => {
    await mount(
      fakeApi(
        [API, WEB],
        [status(API), status(WEB)],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60 * 60_000), endedAt: iso(-50 * 60_000) }),
          session("s3", "ws_b", { status: "failed", claudeSessionId: "59094224-bb3d", startedAt: iso(-2 * 24 * 60 * 60_000 - 60_000), endedAt: iso(-2 * 24 * 60 * 60_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("fix the port list")).toBeDefined());
    // Threads never fold: the settled one stands under the working one. The one idle two days is past the archive
    // threshold, so it sits in its workspace's Archived group, shut.
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "thread:s1", "thread:s2", "ws:ws_b", "archived:ws_b"]);
    // The one slot at the right edge: the state word while a thread is one a person acts on, the time once it rests.
    expect(threadTime(rowOf("fix the port list"))).toBeNull();
    expect(threadTime(rowOf("upgrade node"))).toBe("50m");
    fireEvent.click(screen.getByRole("button", { name: "Archived 1" }));
    // a session without a prompt falls back to the harness session id
    expect(threadTime(rowOf("59094224-bb3d"))).toBeNull();
    // status pills: the running one works, the one that never settled failed, the idle one is plain
    expect(threadState(rowOf("fix the port list"))).toBe("Working");
    expect(threadState(rowOf("59094224-bb3d"))).toBe("Failed");
    expect(within(rowOf("upgrade node")).queryByLabelText(/Idle|Completed/)).toBeNull();
    // No Idle row over threads anywhere: two workspaces are not enough to fold.
    expect(screen.queryByRole("button", { name: /^Idle/ })).toBeNull();
    expect(screen.queryByText(/Settled/)).toBeNull();
  });

  it("a thread stopped on a permission prompt says so on its row and on its workspace's third line, and goes back to working when it is answered", async () => {
    const asking = "Permission for Bash: Check wsp version";
    await mount(fakeApi([API], [status(API)], [session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000), asking })]), "api");
    await waitFor(() => expect(screen.getByText("fix the port list")).toBeDefined());
    expect(threadState(rowOf("fix the port list"))).toBe("Needs you");
    expect(threadState(rowOf("fix the port list"))).not.toBe("Working");
    // The workspace's own row carries the sentence a person is waiting on, cut at the row's cap.
    expect(rowOf("api").textContent).toContain("Permission for Bash: Check");
    act(() => useStore.setState({ sessions: { ws_a: [session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) })] } }));
    await waitFor(() => expect(threadState(rowOf("fix the port list"))).toBe("Working"));
    expect(rowOf("api").textContent).not.toContain("Permission for Bash");
  });

  it("three workspaces in mixed states stand in the order they were made, whatever each machine is doing; a creating row waits at the foot", async () => {
    const gone = view("ws_gone", "scratch", "running", 3 * 24 * 60 * 60_000);
    const paused = view("ws_nap", "spike", "napping", 2 * 60 * 60_000);
    const running = view("ws_run", "dev", "running", 60_000);
    await mount(fakeApi([gone, paused, running], [status(gone, { machineState: "gone", reach: { state: "gone" } }), status(paused), status(running)]), "dev");
    await waitFor(() => expect(rowIds()).toEqual(["project:pr_1", "ws:ws_gone", "ws:ws_nap", "ws:ws_run"]));
    // The state slot: the running row says nothing in words (the dot says it); every other state's word sits in it.
    expect(rowOf("dev").textContent).not.toContain("Running");
    expect(stateSlot(rowOf("dev")).textContent).toBe("");
    expect(stateSlot(rowOf("spike")).textContent).toBe("Stopped");
    expect(stateSlot(rowOf("scratch")).textContent).toBe("Gone");
    for (const name of ["dev", "spike", "scratch"]) {
      const slot = stateSlot(rowOf(name));
      // The slot is the last thing on the name's line, in the muted mono every row's meta wears, whether or not it holds a word.
      expect(slot.parentElement!.lastElementChild).toBe(slot);
      expect(slot.parentElement!.contains(screen.getByText(name))).toBe(true);
      expect(slot.className).toContain("font-mono");
      expect(slot.className).toContain("shrink-0");
      expect(slot.className).not.toMatch(/success|emerald|green/);
    }
    // The one being made is the newest thing here, so it waits where it will stand once it is a workspace.
    act(() => useStore.setState({ creations: [{ key: "creating:1", name: "beta", askedAt: Date.now(), workspaceId: null, lines: [], failed: null }] }));
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_gone", "ws:ws_nap", "ws:ws_run", "creating:1"]);
  });

  it("every thread row leads with the agent's own mark in its colour, and names the agent, the project and who opened it in its hover text alone", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedBy: "cli" }),
          session("s2", "ws_a", { prompt: "upgrade node", harness: "codex", startedBy: "person" }),
          session("s3", "ws_a", { prompt: "before provenance" }),
          session("s4", "ws_a", { prompt: "from the director", startedBy: "agent" }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("fix the port list")).toBeDefined());
    const reads = (title: string) => {
      const row = rowOf(title);
      const lead = row.firstElementChild!;
      const mark = lead.querySelector("[data-harness-mark]")!;
      // A mark with inks wears its first as its colour; a monochrome mark inherits the row's ink from the lead it sits in.
      const tone = [...mark.classList].find(c => c.startsWith("text-"));
      expect(lead.getAttribute("aria-hidden")).toBe("true");
      expect(lead.nextElementSibling!.hasAttribute("data-thread-title")).toBe(true);
      return { label: row.getAttribute("title"), text: row.textContent, mark: mark.getAttribute("data-harness-mark"), svg: mark.tagName, tone, size: [...mark.classList].find(c => c.startsWith("size-")) };
    };
    expect(reads("fix the port list")).toEqual({ label: "Claude Code, the-project, cli", text: "fix the port listWorking", mark: "claude", svg: "svg", tone: "text-(--ink-0)", size: "size-[13px]" });
    expect(reads("upgrade node")).toEqual({ label: "Codex, the-project, you", text: "upgrade nodeWorking", mark: "codex", svg: "svg", tone: undefined, size: "size-[13px]" });
    expect(reads("before provenance")).toEqual({ label: "Claude Code, the-project, you", text: "before provenanceWorking", mark: "claude", svg: "svg", tone: "text-(--ink-0)", size: "size-[13px]" });
    expect(reads("from the director")).toEqual({ label: "Claude Code, the-project, agent", text: "from the directorWorking", mark: "claude", svg: "svg", tone: "text-(--ink-0)", size: "size-[13px]" });
    // Nothing on the face but the title and the slot: no second line, no dots drawn as text, no opener word.
    for (const title of ["fix the port list", "upgrade node"]) {
      expect(rowOf(title).querySelector("[data-thread-meta], [data-thread-provenance]")).toBeNull();
      expect(rowOf(title).textContent).not.toMatch(/·|the-project|cli|you/);
    }
  });

  it("a thread row does not repeat its workspace's project on its face: the tree names it, and the hover text carries it", async () => {
    const project = { id: "pr_spoo", name: "spoo", path: "/root/spoo", computer: "default" };
    await mount(
      fakeApi(
        [{ ...API, project }],
        [status({ ...API, project })],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedBy: "cli", cwd: "/root/spoo" }),
          session("s2", "ws_a", { prompt: "upgrade node", harness: "codex", startedBy: "person", cwd: "/root/wsp/packages/host" }),
          session("s3", "ws_a", { prompt: "no project", cwd: "/root" }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("fix the port list")).toBeDefined());
    // The project the host's list does not carry keeps a row of its own off the workspace's record, over the rows.
    expect(rowIds()).toEqual(["project:pr_1", "project:pr_spoo", "ws:ws_a", "thread:s1", "thread:s2", "thread:s3"]);
    expect(rowOf("spoo").dataset["depth"]).toBe("0");
    for (const title of ["fix the port list", "upgrade node", "no project"]) {
      expect(rowOf(title).textContent).not.toContain("spoo");
      expect(rowOf(title).getAttribute("title")).toContain(", spoo,");
      expect(rowOf(title).className).toBe(rowOf("fix the port list").className);
    }
    expect(rowOf("fix the port list").getAttribute("title")).toBe("Claude Code, spoo, cli");
    expect(rowOf("no project").getAttribute("title")).toBe("Claude Code, spoo, you");
  });

  it("a long title shares its line with the one slot alone, which holds the state word or the time, and every row is one height", async () => {
    const LONG = "Now reply with exactly the word pong.";
    const SHORT = "Reply with exactly the word hi.";
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { prompt: LONG, startedBy: "person", startedAt: iso(-48 * 60_000) }),
          session("s2", "ws_a", { status: "completed", prompt: SHORT, startedBy: "cli", startedAt: iso(-30 * 60_000), endedAt: iso(-24 * 60_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText(LONG)).toBeDefined());
    const title = screen.getByText(LONG);
    expect(title.className).toContain("truncate");
    // The lead, the title and the slot: three children of the row and nothing else.
    expect(title.parentElement).toBe(rowOf(LONG));
    expect(rowOf(LONG).children).toHaveLength(3);
    expect(title.nextElementSibling!.hasAttribute("data-thread-state")).toBe(true);
    expect(title.nextElementSibling!.textContent).toBe("Working");
    expect(screen.getByText(SHORT).nextElementSibling!.hasAttribute("data-thread-time")).toBe(true);
    expect(screen.getByText(SHORT).nextElementSibling!.textContent).toBe("24m");
    // The slot is its own width, not a fixed column: a time takes no more room than it needs.
    for (const slot of [title.nextElementSibling!, screen.getByText(SHORT).nextElementSibling!]) {
      expect(slot.className).toContain("font-mono");
      expect(slot.className).toContain("shrink-0");
      expect(slot.className).not.toMatch(/w-\[|min-w-/);
    }
    expect(rowOf(SHORT).className).toBe(rowOf(LONG).className);
  });

  it("never folds a workspace's threads: the settled ones stand under the working ones with no Idle row", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s0", "ws_a", { prompt: "fix the port list", startedAt: iso(-10_000) }),
          session("s1", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "bump the lockfile", startedAt: iso(-120_000), endedAt: iso(-2_000) }),
          session("s3", "ws_a", { status: "interrupted", prompt: "drop the old shim", startedAt: iso(-180_000), endedAt: iso(-3_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("upgrade node")).toBeDefined());
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "thread:s0", "thread:s1", "thread:s2", "thread:s3"]);
    expect(screen.queryByRole("button", { name: /^Idle/ })).toBeNull();
  });

  it("stands up to three idle workspaces as rows of their own, with no fold", async () => {
    const idle = [view("ws_i1", "one"), view("ws_i2", "two"), view("ws_i3", "three")];
    await mount(fakeApi([API, ...idle], [status(API), ...idle.map(w => status(w))], [session("s1", "ws_a", { prompt: "fix the port list" })]), "api");
    await waitFor(() => expect(rowIds()).toContain("ws:ws_i3"));
    expect(rowIds().filter(id => id?.startsWith("ws:")).sort()).toEqual(["ws:ws_a", "ws:ws_i1", "ws:ws_i2", "ws:ws_i3"]);
    expect(screen.queryByRole("button", { name: /^Idle/ })).toBeNull();
  });

  it("folds a project's idle workspaces under one Idle row past three, shut at first, and remembers it opened per project", async () => {
    const idle = [view("ws_i1", "one"), view("ws_i2", "two"), view("ws_i3", "three"), view("ws_i4", "four")];
    await mount(fakeApi([API, ...idle], [status(API), ...idle.map(w => status(w))], [session("s1", "ws_a", { prompt: "fix the port list" })]), "api");
    const fold = (): HTMLElement => document.querySelector<HTMLElement>("[data-row-id='settled:pr_1']")!;
    await waitFor(() => expect(fold()).not.toBeNull());
    // The working workspace stands; the four with nothing running are behind the fold, which says how many.
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "thread:s1", "settled:pr_1"]);
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    expect(fold().getAttribute("aria-label")).toBe("Idle 4");
    expect(fold().textContent).toBe("Idle4");
    fireEvent.click(fold());
    expect(fold().getAttribute("aria-label")).toBe("Idle");
    expect(rowIds().filter(id => id?.startsWith("ws:ws_i"))).toHaveLength(4);
    expect(rowIds().indexOf("settled:pr_1")).toBeLessThan(rowIds().indexOf("ws:ws_i1"));
    expect(window.localStorage.getItem("wsp:sidebar-idle-open")).toBe('["pr_1"]');
    fireEvent.click(fold());
    expect(rowIds().filter(id => id?.startsWith("ws:ws_i"))).toHaveLength(0);
    expect(window.localStorage.getItem("wsp:sidebar-idle-open")).toBe("[]");
  });

  it("a remembered open fold is open on the next mount", async () => {
    window.localStorage.setItem("wsp:sidebar-idle-open", '["pr_1"]');
    const idle = [view("ws_i1", "one"), view("ws_i2", "two"), view("ws_i3", "three"), view("ws_i4", "four")];
    await mount(fakeApi(idle, idle.map(w => status(w))), "one");
    await waitFor(() => expect(document.querySelector("[data-row-id='settled:pr_1']")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Idle" }).getAttribute("aria-expanded")).toBe("true");
    expect(rowIds().filter(id => id?.startsWith("ws:ws_i"))).toHaveLength(4);
  });

  it("threads idle past the archive threshold fold into an Archived group, shut, carrying their count", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "bump the lockfile", startedAt: iso(-2 * 24 * 60 * 60_000), endedAt: iso(-25 * 60 * 60_000) }),
          session("s3", "ws_a", { status: "interrupted", prompt: "drop the old shim", startedAt: iso(-9 * 24 * 60 * 60_000), endedAt: iso(-8 * 24 * 60 * 60_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("upgrade node")).toBeDefined());
    // The archive sits after the settled threads, shut, and the two threads quiet for over a day are not drawn.
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "thread:s1", "archived:ws_a"]);
    const archived = (): HTMLElement => document.querySelector<HTMLElement>("[data-row-id='archived:ws_a']")!;
    expect(archived().getAttribute("aria-expanded")).toBe("false");
    expect(archived().getAttribute("aria-label")).toBe("Archived 2");
    expect(screen.queryByText("bump the lockfile")).toBeNull();
    // One click opens it, and the rows arrive newest end first, as the shelf orders its own.
    fireEvent.click(archived());
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "thread:s1", "archived:ws_a", "thread:s2", "thread:s3"]);
    expect(archived().getAttribute("aria-label")).toBe("Archived");
    expect(window.localStorage.getItem("wsp:sidebar-archived-open")).toBe('["ws_a"]');
    fireEvent.click(archived());
    expect(screen.queryByText("bump the lockfile")).toBeNull();
    expect(window.localStorage.getItem("wsp:sidebar-archived-open")).toBe("[]");
  });

  it("one click on an archived thread's row opens that thread", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "bump the lockfile", threadId: "thr_old", startedAt: iso(-3 * 24 * 60 * 60_000), endedAt: iso(-2 * 24 * 60 * 60_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Archived 1" })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Archived 1" }));
    fireEvent.click(rowOf("bump the lockfile"));
    expect(useStore.getState().selectedId).toBe("ws_a");
    expect(useStore.getState().selectedThreadId).toBe("thr_old");
  });

  it("a workspace whose threads are every one archived draws the archive alone", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [session("s1", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-9 * 24 * 60 * 60_000), endedAt: iso(-8 * 24 * 60 * 60_000) })],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Archived 1" })).toBeDefined());
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "archived:ws_a"]);
    expect(screen.queryByRole("button", { name: /^Idle/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archived 1" }));
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "archived:ws_a", "thread:s1"]);
    expect(screen.getByRole("button", { name: "Archived" })).toBeDefined();
  });

  it("an idle thread's title reads in the muted foreground; a working one's does not", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("upgrade node")).toBeDefined());
    const title = (text: string): HTMLElement => rowOf(text).querySelector<HTMLElement>("[data-thread-title]")!;
    expect(title("upgrade node").className).toContain("text-sidebar-muted-foreground");
    expect(title("fix the port list").className).not.toContain("text-sidebar-muted-foreground");
  });

  it("a workspace row's second line is the branch its copy stands on, cut at the row's cap with the whole of it in its title, and no figure, no copy word and no port word of any kind", async () => {
    const copied = { ...API, copy: { road: "clonefile" as const, path: "/Users/dev/spoo-api", source: "/Users/dev/spoo", base: "abc", branch: "agent/api-port-list", carried: "deps-and-config" as const }, portBase: 3100 };
    await mount(
      fakeApi([copied, WEB], [status(copied, { idleAt: iso(14.5 * 60_000), reach: { state: "slow" } }), status(WEB)]),
      "api",
    );
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe("agent/api-port-list"));
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(stateSlot(rowOf("web")).textContent).toBe("Stopped");
    // A fork carries no copy of a folder and so no branch: its row is one line at a thread row's height, with no
    // blank second line, while the copy on a branch keeps its two.
    expect(rowOf("web").querySelector("[data-workspace-meta]")).toBeNull();
    expect(rowOf("web").dataset["lines"]).toBe("1");
    expect(rowOf("api").dataset["lines"]).toBe("2");
    expect([...rowOf("web").classList].filter(c => /^h-/.test(c))).toEqual(["h-9"]);
    expect([...rowOf("api").classList].filter(c => /^h-/.test(c))).toEqual(["h-13"]);
    // The branch says what it is by its glyph.
    expect(metaOf(rowOf("api")).parentElement!.querySelector("svg.lucide-git-branch")).not.toBeNull();
    const meta = metaOf(rowOf("api"));
    expect(meta.className).toContain("font-mono");
    expect(meta.className).toContain("truncate");
    // The copy road and the port rule left the row: the tree says whose copy this is, and a port is a fact for the
    // workspace's own page. Two lines, the name's and this one, and no glyph before the name.
    for (const name of ["api", "web"]) {
      expect(rowOf(name).querySelector("[data-workspace-made-of], [data-workspace-lead]")).toBeNull();
      expect(rowOf(name).textContent).not.toMatch(/a copy|in this folder|ports|PORT/);
      expect(rowOf(name).firstElementChild!.contains(rowOf(name).querySelector("[data-workspace-name]"))).toBe(true);
    }
    // The meter ticks and nothing on the row moves: spend belongs to the computer's row in Settings.
    act(() =>
      useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 120_000, accruedUsd: 0.29, at: new Date(NOW).toISOString() }),
    );
    expect(metaOf(rowOf("api")).textContent).toBe("agent/api-port-list");
    expect(rowOf("api").textContent).not.toContain("$");
  });

  it("this computer's own daemon down: the row says No daemon in its slot and the line under the name says start it, and the row carries no glyph for it", async () => {
    const MAC: WorkspaceView = { ...view("ws_m", "zingzy-mac"), kind: "local", machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, golden: "" };
    const api = fakeApi([MAC], [{ ...status(MAC), kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0, reach: { state: "unreachable" } }]);
    api.restartDaemon = vi.fn(async () => {});
    await mount(api, "zingzy-mac");
    const row = () => rowOf("zingzy-mac");
    await waitFor(() => expect(stateSlot(row()).textContent).toBe("No daemon"));
    expect(metaOf(row()).textContent).toBe("daemon not running, start it");
    // The start is the row's menu's, as every other action is: the row's face holds its words and nothing to press.
    expect(screen.queryByRole("button", { name: "Start the daemon of zingzy-mac" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New thread in zingzy-mac" })).toBeNull();
    // And the daemon answering clears the slot.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(MAC), kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0 } }));
    await waitFor(() => expect(stateSlot(row()).textContent).toBe(""));
  });

  it("every workspace row on a branch is one two-line height, every thread row one line, the mark before a thread's title and one slot after it, and every row fades its colours alike", async () => {
    await mount(
      fakeApi(
        [COPIED],
        [status(COPIED)],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("upgrade node")).toBeDefined());
    const heightOf = (row: HTMLElement) => [...row.classList].filter(c => /^(h-|min-h-|py-)/.test(c)).sort();
    // The project row is two lines too, its computer over its name.
    expect(heightOf(rowOf("spoo-landing"))).toEqual(["h-13", "py-0"]);
    expect(heightOf(rowOf("api"))).toEqual(["h-13", "py-0"]);
    expect(heightOf(rowOf("fix the port list"))).toEqual(["h-9", "py-0"]);
    expect(heightOf(rowOf("upgrade node"))).toEqual(["h-9", "py-0"]);
    // A button centres its text unless told otherwise; a short title starts where a long one does.
    for (const row of [rowOf("api"), rowOf("fix the port list")]) expect(row.className).toContain("text-left");
    // One hover on every row kind: the fill and the ink step in 150 ms on the workspace and the thread as on the
    // search row, the head and the project row, so no row snaps while the one above it fades.
    for (const row of [rowOf("spoo-landing"), rowOf("api"), rowOf("fix the port list"), rowOf("upgrade node"), screen.getByRole("button", { name: "Search" }), head()]) {
      expect(row.className, row.textContent ?? "").toContain("transition-[background-color,color]");
      expect(row.className, row.textContent ?? "").toContain("duration-150");
    }
    // The thread title takes the line from the mark up to the one slot at the right, nothing else beside it.
    const title = rowOf("fix the port list").querySelector<HTMLElement>("[data-thread-title]")!;
    expect(title.className).toContain("flex-1");
    expect(title.className).toContain("truncate");
    const slot = title.nextElementSibling as HTMLElement;
    expect(rowOf("fix the port list").children).toHaveLength(3);
    expect(slot.textContent).toBe("Working");
    expect(slot.className).toContain("font-mono");
    expect(slot.className).toContain("text-right");
    expect(slot.className).toContain("shrink-0");
    expect(rowOf("upgrade node").querySelector("[data-thread-time]")!.textContent).toBe("now");
    // The mark leads the title: the row's first child is the lead and the title comes after it.
    expect(rowOf("fix the port list").firstElementChild!.querySelector("[data-harness-mark]")).not.toBeNull();
    expect(rowOf("fix the port list").firstElementChild!.nextElementSibling).toBe(title);
    // A workspace row has no lead: its first child is the column of its two lines.
    expect(rowOf("api").firstElementChild!.contains(rowOf("api").querySelector("[data-workspace-name]"))).toBe(true);
  });

  it("while the runtime replaces the machine's helper the row says only that, and goes back to the branch when it lands", async () => {
    const copied = { ...API, copy: { road: "clonefile" as const, path: "/Users/dev/spoo-api", source: "/Users/dev/spoo", base: "abc", branch: "agent/api-port-list", carried: "deps-and-config" as const } };
    await mount(fakeApi([copied, WEB], [status(copied), status(WEB)]), "api");
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe("agent/api-port-list"));

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(copied), daemonNote: DAEMON_UPDATING } }));
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe(DAEMON_UPDATING));
    // The one thing on the row worth waiting for takes the line; the branch waits its turn.
    expect(rowOf("api").textContent).not.toContain("agent/api-port-list");
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(rowOf("web").textContent).not.toContain(DAEMON_UPDATING);

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(copied), daemonNote: DAEMON_UPDATE_FAILED } }));
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe(DAEMON_UPDATE_FAILED));
    // The reason a deploy gave is in the host's log, never on the row: it names the daemon and runs to hundreds of characters.
    expect(rowOf("api").textContent).not.toContain("NPM_FAIL");

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(copied) }));
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe("agent/api-port-list"));
  });

  it("clicking a thread selects it under its workspace; clicking a workspace selects it with no thread pinned", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_b", { prompt: "hello", threadId: "thr_1" })]), "api");
    await waitFor(() => expect(screen.getByText("hello")).toBeDefined());
    fireEvent.click(rowOf("hello"));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: "thr_1" });
    expect(rowOf("hello").getAttribute("data-active")).toBe("true");
    expect(rowOf("web").getAttribute("data-active")).toBe("false");
    fireEvent.click(rowOf("api"));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", selectedThreadId: null });
    expect(rowOf("api").getAttribute("data-active")).toBe("true");
    expect(rowOf("hello").getAttribute("data-active")).toBe("false");
  });

  it("clicking a thread row without a thread id selects its workspace with no thread pinned", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_b", { prompt: "before threads" })]), "api");
    await waitFor(() => expect(screen.getByText("before threads")).toBeDefined());
    fireEvent.click(rowOf("before threads"));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: null });
    expect(rowOf("web").getAttribute("data-active")).toBe("true");
    expect(rowOf("before threads").getAttribute("data-active")).toBe("false");
  });

  it("an empty fleet says so; a refused status read is a notice, never a line in the sidebar", async () => {
    const api = fakeApi([], []);
    api.watchStatuses = vi.fn(async () => { throw new Error("runtime unreachable"); });
    useStore.getState().bind(api);
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    await waitFor(() => expect(screen.getByText(/No tasks yet/)).toBeDefined());
    await waitFor(() => expect(lastNotice()).toBe("Live status is not coming from the host: runtime unreachable"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a refused project list says so where New project would stand", async () => {
    const api = fakeApi([], []);
    api.projectsList = async () => { throw new RequestError("projects.json is not valid JSON"); };
    useStore.getState().bind(api);
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    const line = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-k='projects-refused']");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(line.textContent).toBe("Projects not read: projects.json is not valid JSON");
    expect(document.querySelector("[data-k='new-project']")).toBeNull();
  });
});

describe("new thread", () => {
  it("the compose glyph raises a new-thread request for the selected workspace; no row carries a plus of its own", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    const seen: string[] = [];
    const off = onNewThreadRequest(d => seen.push(d.workspaceId));
    const compose = screen.getByRole("button", { name: "New thread" });
    act(() => useStore.getState().select(null));
    // Held by aria-disabled rather than the disabled attribute, so the pointer still reaches it and its tooltip
    // can say what it is in the one state a person might ask.
    expect(compose.getAttribute("aria-disabled")).toBe("true");
    expect(compose.hasAttribute("disabled")).toBe(false);
    expect(compose.className).not.toContain("pointer-events-none");
    fireEvent.click(compose);
    fireEvent.click(rowOf("web"));
    expect(useStore.getState().selectedId).toBe("ws_b");
    expect(compose.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(compose);
    expect(seen).toEqual(["ws_b"]);
    expect(screen.queryByRole("button", { name: "New thread in web" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New thread in api" })).toBeNull();
    // The collapse chevron keeps its slot on a row with threads.
    expect(screen.getByRole("button", { name: "Collapse api" })).toBeDefined();
    off();
  });

  it("a workspace with no threads draws nothing under its row: selecting it lands in its composer", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    expect(screen.queryByText(/No threads yet/)).toBeNull();
    const item = (row: HTMLElement) => row.closest<HTMLElement>('[data-sidebar="menu-item"]')!;
    expect(item(rowOf("web")).querySelector("ul")).toBeNull();
    expect(item(rowOf("api")).querySelector("ul")).not.toBeNull();
  });

  it("a send in flight is a row of its own, so a workspace running the first message never reads that it has none", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    const item = (row: HTMLElement) => row.closest<HTMLElement>('[data-sidebar="menu-item"]')!;
    expect(item(rowOf("web")).querySelector("ul")).toBeNull();

    // The transcript draws the sent message the moment it is sent; the runtime writes a row only once the agent
    // announces itself, which is seconds later.
    act(() => useStore.setState({ launches: { ws_b: { requestId: "r1", title: "read the port list", harness: "claude" } } }));
    const launched = item(rowOf("web")).querySelector<HTMLElement>("[data-thread-launch]")!;
    expect(launched.querySelector("[data-thread-title]")?.textContent).toBe("read the port list");
    expect(launched.querySelector("[data-thread-state]")?.textContent).toBe("Working");
    // No time yet: nothing has started to count, so the slot holds the word alone.
    expect(launched.querySelector("[data-thread-time]")).toBeNull();
    expect(launched.querySelector('svg[data-harness-mark="claude"]')).not.toBeNull();
    expect([...launched.classList]).toContain("h-9");

    // The workspace that has its own rows keeps them; the send belongs to the workspace it was made on.
    expect(item(rowOf("api")).querySelector("[data-thread-launch]")).toBeNull();
  });

  it("no row carries a project glyph, with or without the export op; a live row's one glyph is its chevron, on hover", async () => {
    const api = fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]);
    api.exportProject = vi.fn();
    await mount(api, "api");
    expect(screen.queryByRole("button", { name: /Import a project/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Export a project/ })).toBeNull();
    expect(document.querySelector("svg.lucide-folder-input, svg.lucide-folder-output")).toBeNull();
    const glyphs = (row: HTMLElement) => Array.from(row.parentElement!.querySelectorAll<HTMLElement>("[data-sidebar=menu-action]")).map(b => b.getAttribute("aria-label"));
    expect(glyphs(rowOf("api"))).toEqual(["Collapse api"]);
    expect(glyphs(rowOf("web"))).toEqual([]);
    // A live row's text runs to its own inset whatever its glyphs, which land in the state slot on hover; the slot yields to them.
    const endPadding = (row: HTMLElement) => [...row.classList].filter(c => /pe-\d/.test(c));
    expect(endPadding(rowOf("api"))).toEqual(endPadding(rowOf("web")));
    expect(endPadding(rowOf("api"))).toEqual(["group-has-data-[sidebar=menu-action]/menu-item:pe-2"]);
    for (const name of ["api", "web"]) {
      expect(stateSlot(rowOf(name)).className).toContain("min-w-[74px]");
      expect(stateSlot(rowOf(name)).className).toContain("group-hover/menu-item:opacity-0");
    }
  });


  it("a zombie row offers the rebuild and no new thread", async () => {
    await mount(fakeApi([API], [status(API, { reach: { state: "zombie" } })]), "api");
    await waitFor(() => expect(screen.getByRole("button", { name: "Rebuild api" })).toBeDefined());
    expect(screen.queryByRole("button", { name: "New thread in api" })).toBeNull();
  });
});


describe("search", () => {
  it("the row is the palette's door: a plain row with a glyph and the word Search, no chord, no fill and no hairline, and the compose glyph alone at the right edge; a click opens the palette, focus alone does not, and no field ever appears", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    const opened: boolean[] = [];
    const off = onOpenCommandPalette(detail => opened.push(detail.toggle === true));
    const row = screen.getByRole("button", { name: "Search" });
    expect(row.querySelector("svg.lucide-search")).not.toBeNull();
    expect(row.textContent).toBe("Search");
    expect(row.querySelector("kbd")).toBeNull();
    const compose = screen.getByRole("button", { name: "New thread" });
    expect(compose.closest("[data-sidebar-search]")).not.toBeNull();
    expect(compose.querySelector("svg.lucide-square-pen")).not.toBeNull();
    expect(row.contains(compose)).toBe(false);
    expect(row.className).toContain("pe-8");
    // The row is the kit's row and nothing more: no fill, no ring, no hairline of its own, the hover tint every other row has.
    expect(row.className).not.toMatch(/(^|\s)(bg-sidebar-row-selected|border-sidebar-border|ring-1|bg-background|bg-sidebar-control-surface)(\s|$)/);
    expect(row.className).toContain("hover:bg-sidebar-row-hover");
    expect(row.className).toContain("h-9");
    // The head sits under it in the same fixed header, over the tree.
    expect(head().closest("[data-sidebar-search]")).not.toBeNull();
    expect(head().closest("[data-slot=sidebar-content]")).toBeNull();
    const before = rowIds();
    // A real button: Tab onto it only focuses it; Enter and Space are the browser's own click, so the click is what opens.
    expect(row.tagName).toBe("BUTTON");
    act(() => row.focus());
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: "Tab" });
    expect(opened).toEqual([]);
    fireEvent.click(row);
    expect(opened).toEqual([false]);
    expect(document.querySelector("input")).toBeNull();
    expect(screen.getByRole("button", { name: "Search" })).toBe(row);
    expect(rowIds()).toEqual(before);
    off();
  });
});

describe("the body before the first list has arrived, and on a wsp with no project", () => {
  it("says nothing at all while the store is not ready: no rows, no bars, not even the road to a project, and the head held", () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    expect(screen.queryByText(/No tasks yet/)).toBeNull();
    expect(rowIds()).toEqual([]);
    expect(document.querySelectorAll("[data-slot=skeleton]").length).toBe(0);
    expect(screen.queryByText(PROJECT_WORDS.add)).toBeNull();
    expect(screen.queryByText(PROJECT_WORDS.new)).toBeNull();
    expect(head().disabled).toBe(true);
    expect(head().textContent).toBe(SWITCHER_WORDS.all);
  });

  it("holds the head, held, and one row that opens Add a project once the lists have arrived and hold nothing: no sentence", async () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    act(() => useStore.setState({ ready: true, projectsRead: true }));
    const row = await screen.findByText(PROJECT_WORDS.new);
    expect(row.closest("button")!.dataset["k"]).toBe("new-project");
    expect(row.closest("button")!.className).toContain("h-9");
    expect(row.closest("button")!.querySelector("svg.lucide-plus")).not.toBeNull();
    expect(head().disabled).toBe(true);
    fireEvent.click(head());
    expect(menu()).toBeNull();
    // The empty line belongs to a project with no workspace; with no project at all the centre is the first run,
    // whose title says what is being made, so no second sentence stands here.
    expect(screen.queryByText(/No tasks yet/)).toBeNull();
    expect(screen.queryByText(/No projects yet/)).toBeNull();
    expect(screen.queryByText(/A project is a folder/)).toBeNull();
    expect(screen.queryByText(PROJECT_WORDS.add)).toBeNull();
    expect(rowIds()).toEqual([]);
    // The compose glyph stands, held: there is no workspace to open a thread in.
    expect(screen.getByRole("button", { name: "New thread" }).getAttribute("aria-disabled")).toBe("true");
    // Pressing the row opens the same Add a project dialog the first run's button opens.
    expect(document.querySelector("[data-k=add-project]")).toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(document.querySelector("[data-k=add-project]")).not.toBeNull());
  });

  it("a creation on its way holds the empty state off while the list is still coming", () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    act(() => useStore.setState({ creations: [{ key: "creating:1", name: "beta", askedAt: Date.now(), workspaceId: null, lines: [], failed: null }] }));
    expect(screen.getByText("beta")).toBeDefined();
    expect(screen.queryByText(/No tasks yet/)).toBeNull();
    expect(screen.queryByText(PROJECT_WORDS.new)).toBeNull();
  });
});

describe("keyboard navigation", () => {
  it("arrows walk every row in order from the search row; Enter selects", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    await waitFor(() => expect(screen.getByText("hello")).toBeDefined());
    const search = screen.getByRole("button", { name: "Search" });
    act(() => search.focus());
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("spoo-landing"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("api"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("hello"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("web"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("web"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(rowOf("spoo-landing"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(rowOf("web"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rowOf("hello"));
    fireEvent.click(document.activeElement!);
    expect(useStore.getState().selectedId).toBe("ws_a");
  });

  it("ArrowDown on the head opens the menu and moves no row focus; Escape shuts it and puts focus back on the head", async () => {
    await mount(fakeApi([API], [status(API)]), "api");
    act(() => head().focus());
    fireEvent.keyDown(head(), { key: "ArrowDown" });
    expect(menu()).not.toBeNull();
    expect(document.activeElement).not.toBe(rowOf("api"));
    fireEvent.keyDown(menu()!, { key: "Escape" });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(head());
  });
});


describe("gone machines", () => {
  const OLD: WorkspaceView = { ...view("ws_c", "old", "gone"), gone: "machine m_ws_c is gone at the provider: Not found" };

  it("a gone row reads Gone with no rate or countdown, offers the rebuild with the provider's words, and no new thread", async () => {
    await mount(fakeApi([OLD], [status(OLD, { machineState: "gone", reach: { state: "gone" }, reason: OLD.gone! })]), "old");
    const row = rowOf("old");
    expect(row.textContent).toContain("Gone");
    expect(row.textContent).not.toContain("/hr");
    expect(row.textContent).not.toContain("naps");
    expect(row.textContent).not.toContain("active");
    expect(screen.getByRole("button", { name: "Rebuild old" }).getAttribute("title")).toBe("machine m_ws_c is gone at the provider: Not found");
    expect(screen.queryByRole("button", { name: "New thread in old" })).toBeNull();
  });

  it("a record still saying running whose status found the machine gone reads Gone, and no figure reaches the row whatever the meter says", async () => {
    const gone = status(API, { machineState: "gone", reach: { state: "gone" }, idleAt: NOW + 17 * 60_000, rateUsdPerHour: 0.11, reason: "machine m_ws_a is gone at the provider: the status poll found it gone at 2026-09-06T10:21:04Z" });
    await mount(fakeApi([API], [gone]), "api");
    act(() => useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 60_000, accruedUsd: 0.18, at: new Date(NOW).toISOString() }));
    const row = rowOf("api");
    await waitFor(() => expect(row.textContent).toContain("Gone"));
    expect(row.textContent).not.toContain("/hr");
    expect(row.textContent).not.toContain("naps");
    expect(row.textContent).not.toContain("active");
    // What a machine costs is its computer's row in Settings; no row here carries a figure.
    expect(row.textContent).not.toContain("$0.18");
    expect(screen.getByRole("button", { name: "Rebuild api" }).getAttribute("title")).toBe(gone.reason!);
  });

  it("a gone row offers forget beside the rebuild; confirming names what goes, calls the api once, and the row leaves on workspace.deleted", async () => {
    const api = await mount(fakeApi([OLD], [status(OLD)], [session("s1", "ws_c", { prompt: "fix the port list", status: "completed" })]), "old");
    await waitFor(() => expect(stateSlot(rowOf("old")).textContent).toBe("Gone"));
    // The two recovery glyphs sit in the row's two right-edge slots, forget before rebuild, on hover like every
    // row's glyphs: the resting row carries its word alone, and the word yields to them so nothing moves.
    const recovery = Array.from(rowOf("old").parentElement!.querySelectorAll<HTMLElement>("[data-sidebar=menu-action]"));
    expect(recovery.map(b => b.getAttribute("aria-label"))).toEqual(["Forget old", "Rebuild old"]);
    expect(recovery.map(b => [...b.classList].find(c => c.startsWith("right-")))).toEqual(["right-7.5", "right-1.5"]);
    for (const glyph of recovery) expect(glyph.className).toContain("md:opacity-0");
    expect(stateSlot(rowOf("old")).className).toContain("group-hover/menu-item:opacity-0");
    expect([...rowOf("old").classList].filter(c => /pe-\d/.test(c))).toEqual(["group-has-data-[sidebar=menu-action]/menu-item:pe-2"]);
    fireEvent.click(screen.getByRole("button", { name: "Forget old" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Forget old?");
    expect(dialog.textContent).toContain("Its record and 1 thread leave this computer; the computer it ran on is already gone.");
    expect(api.forget).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(api.forget).toHaveBeenCalledTimes(1));
    expect(api.forget).toHaveBeenCalledWith("ws_c");
    act(() => useStore.getState().applyEvent({ type: "workspace.deleted", workspaceId: "ws_c" }));
    await waitFor(() => expect(screen.queryByText("old")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("the host's refusal shows in the dialog and the row stays", async () => {
    const api = await mount(fakeApi([OLD], [status(OLD)]), "old");
    const reason = "old's machine m_ws_c is still running; pause it or delete it at the provider first";
    api.forget.mockRejectedValueOnce(new RequestError(reason, "conflict"));
    fireEvent.click(screen.getByRole("button", { name: "Forget old" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(screen.getByText(reason)).toBeDefined());
    expect(rowOf("old").textContent).toContain("Gone");
  });
});

describe("a machine that stopped answering with memory near full", () => {
  it("the row's second line is the short form with the last figures, and clears when the link is back", async () => {
    const GiB = 1024 ** 3;
    resetLive();
    await mount(fakeApi([API], [status(API, { reach: { state: "unreachable" } })]), "api");
    act(() => {
      getLive("ws_a").feedStatus("live");
      getLive("ws_a").feedSample({ type: "sys.sample", cpu: 99, load1: 6.4, mem: { used: 3.59 * GiB, total: 3.94 * GiB }, disk: { used: 1, total: 10 }, at: 1 });
    });
    const meta = () => rowOf("api").querySelector("[data-workspace-meta]")?.textContent ?? "";
    expect(meta()).not.toContain("Out of memory");
    act(() => getLive("ws_a").feedStatus("connecting"));
    await waitFor(() => expect(meta()).toBe("out of memory, 3.6 of 3.9 GB"));
    expect(rowOf("api").textContent).toContain("Unreachable");
    act(() => getLive("ws_a").feedStatus("live"));
    await waitFor(() => expect(meta()).not.toContain("Out of memory"));
  });
});

describe("the row's third line after a bring back", () => {
  it("is drawn whole, cut by the slot's own width and by no count of characters, with the host's note on the hover", async () => {
    await mount(fakeApi([API], [status(API)]), "api");
    const note = "no signed-in command line for github.com is on this computer; the branch is pushed and the pull request waits for one";
    act(() => useStore.setState({ broughtBack: { ws_a: { branch: "agent/readme-badge", base: "main", ahead: 1, uncommitted: 0, stat: [], note } } }));
    const meta = () => metaOf(rowOf("api"));
    // 44 characters, over the cap a row used to cut every line three at; the slot wears truncate and the width
    // decides, so at a wider sidebar the whole of it reads.
    await waitFor(() => expect(meta().textContent).toBe("agent/readme-badge pushed, no pull request"));
    expect(meta().className.split(" ")).toContain("truncate");
    expect(meta().getAttribute("title")).toBe(`agent/readme-badge pushed, no pull request: ${note}`);
  });
});

describe("zombie machines", () => {
  it("reads as its own state with the reason on hover and a one-shot rebuild", async () => {
    const zombie = status(API, { reach: { state: "zombie" }, reason: "exec probe failed after 3 tries; slow since 12:01" });
    const api = await mount(fakeApi([API], [zombie]), "api");
    await waitFor(() => expect(rowOf("api").textContent).toContain("Unreachable"));
    expect(rowOf("api").textContent).not.toContain("Running");
    const rebuild = screen.getByRole("button", { name: "Rebuild api" });
    expect(rebuild.getAttribute("title")).toContain("exec probe failed");
    fireEvent.click(rebuild);
    fireEvent.click(rebuild);
    await waitFor(() => expect(api.rebuild).toHaveBeenCalledTimes(1));
    expect(api.rebuild).toHaveBeenCalledWith("ws_a");
    expect(screen.getByRole("button", { name: "Rebuild api" }).hasAttribute("disabled")).toBe(true);
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(API), machineId: "m_rebuilt" } }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Rebuild api" })).toBeNull());
    expect(stateSlot(rowOf("api")).textContent).toBe("");
  });
});

describe("Solari out of reach from this computer", () => {
  it("a status whose probe never left this computer puts one muted mono line under the search row, leaves every row's word alone, and the line goes when a probe gets out again", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)]), "api");
    await waitFor(() => expect(stateSlot(rowOf("web")).textContent).toBe("Stopped"));
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(screen.queryByText(PROVIDER_UNREACHED_LINE)).toBeNull();

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { reach: { state: "reachable", offline: true } }) }));
    const line = await screen.findByText(PROVIDER_UNREACHED_LINE);
    expect(line.closest("[data-sidebar-search]")).not.toBeNull();
    expect(line.className).toContain("font-mono");
    expect(line.className).not.toMatch(/border|bg-|badge|chip|destructive|warning|success/);
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(rowOf("api").textContent).not.toContain("Unreachable");
    expect(stateSlot(rowOf("web")).textContent).toBe("Stopped");
    // The line reads once, however many rows carry the flag.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(WEB, { reach: { state: "napping", offline: true } }) }));
    expect(screen.getAllByText(PROVIDER_UNREACHED_LINE)).toHaveLength(1);

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API) }));
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(WEB) }));
    await waitFor(() => expect(screen.queryByText(PROVIDER_UNREACHED_LINE)).toBeNull());
  });

  it("keeps the slot under the search row for the host's own two lines, never a workspace's link", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)]), "api");
    await waitFor(() => expect(rowOf("api")).toBeDefined());
    // The workspace on screen has a link that nothing has answered on. Its sentence belongs to the pane that
    // asked and to the composer under the box, both of which sit beside the workspace they name; drawn here, in
    // the opposite corner, it read as a line about nothing and named no workspace.
    const wt = new WorkspaceTerminals({ request: async () => ({ ok: true }) });
    act(() => {
      wt.feedStatus("unanswered");
      provideTerminals(API.id, wt);
    });
    await waitFor(() => expect(rowOf("api")).toBeDefined());
    const slot = document.querySelector("[data-sidebar-search]")!;
    expect(slot.querySelector("[data-sidebar-link-down]")).toBeNull();
    expect(slot.textContent).not.toContain("Nothing has answered");
    provideTerminals(API.id, null);
    // The two the slot does carry stay: this computer asleep, and a poll that never left it.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { reach: { state: "reachable", offline: true } }) }));
    expect((await screen.findByText(PROVIDER_UNREACHED_LINE)).closest("[data-sidebar-search]")).not.toBeNull();
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API) }));
  });

  it("draws the threads a thread's agent opened one step in under it, each saying its own state in the slot, with where it runs in the hover text", async () => {
    const lead = session("s1", "ws_a", { prompt: "ship the search rewrite", startedBy: "person", threadId: "th_lead" });
    await mount(
      fakeApi(
        [API],
        // The provider the record carries is what the hover names, never the id the provider minted for the machine.
        [status(API, { machineId: "sb_9f2c1d8a", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, provider: "solari" })],
        [
          lead,
          session("s2", "ws_a", { prompt: "write the migration", startedBy: "agent", threadId: "th_mig", parentThreadId: "th_lead" }),
          session("s3", "ws_a", { status: "failed", prompt: "review the diff", startedBy: "agent", threadId: "th_rev", parentThreadId: "th_lead" }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("write the migration")).toBeDefined());
    // One state, one word, whoever opened the thread: the indent says an agent did, and the slot says what it is doing.
    expect(threadState(rowOf("write the migration"))).toBe("Working");
    expect(threadState(rowOf("review the diff"))).toBe("Failed");
    expect(threadState(rowOf("ship the search rewrite"))).toBe("Working");
    // The workspace it runs in is the one it is drawn under, so the hover text holds where that workspace runs and nothing else.
    expect(rowOf("write the migration").getAttribute("title")).toBe("Claude Code, solari");
    expect(rowOf("ship the search rewrite").getAttribute("title")).toBe("Claude Code, the-project, you");
    expect(depthOf(rowOf("write the migration"))).toBe(depthOf(rowOf("ship the search rewrite")) + 1);
    // Real nesting: the working child sits in a list inside the opener's item. The one that failed rests among the
    // settled threads, parted from its working opener, so it keeps the workspace's thread depth there.
    expect(rowOf("ship the search rewrite").closest("li[data-thread-item]")!.contains(rowOf("write the migration"))).toBe(true);
    expect(rowOf("ship the search rewrite").closest("li[data-thread-item]")!.contains(rowOf("review the diff"))).toBe(false);
    expect(depthOf(rowOf("review the diff"))).toBe(depthOf(rowOf("ship the search rewrite")));
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "thread:th_lead", "thread:th_mig", "thread:th_rev"]);
  });
});

describe("a thread an agent opened on another workspace", () => {
  // The orchestrator's own workspace is this computer and the builder it opened runs on a fork at a provider; the
  // sidebar files each thread under the workspace its session belongs to, which is what used to part the two.
  const MAC = { ...view("ws_mac", "zingzy's Mac", "running", 3 * 60 * 60_000), kind: "local" as const };
  const BENCH = view("ws_bench", "spoo-bench", "running", 60 * 60_000);

  const opened = async () =>
    mount(
      fakeApi(
        [MAC, BENCH],
        [status(MAC), status(BENCH, { machineId: "sb_9f2c1d8a", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, provider: "ascii" })],
        [
          session("s1", "ws_mac", { prompt: "run the migration across the fleet", startedBy: "person", threadId: "th_lead", startedAt: iso(-60_000) }),
          session("s2", "ws_bench", { prompt: "benchmark the new index", startedBy: "agent", threadId: "th_bench", parentThreadId: "th_lead", startedAt: iso(-600_000) }),
        ],
      ),
      "zingzy's Mac",
    );

  it("is drawn one step in under the thread that opened it, not under the workspace its session is filed against", async () => {
    await opened();
    await waitFor(() => expect(screen.getByText("benchmark the new index")).toBeDefined());
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_mac", "thread:th_lead", "thread:th_bench", "ws:ws_bench"]);
    expect(depthOf(rowOf("benchmark the new index"))).toBe(depthOf(rowOf("run the migration across the fleet")) + 1);
  });

  it("names the workspace it runs in and then where that workspace runs in its hover text, the two facts the row above it does not carry", async () => {
    await opened();
    await waitFor(() => expect(screen.getByText("benchmark the new index")).toBeDefined());
    expect(rowOf("benchmark the new index").getAttribute("title")).toBe("Claude Code, spoo-bench, ascii");
    expect(rowOf("run the migration across the fleet").getAttribute("title")).toBe("Claude Code, the-project, you");
    // Nothing of that on either face: the title and the slot alone.
    expect(rowOf("benchmark the new index").textContent).toBe("benchmark the new indexWorking");
  });
});

describe("the row's third line", () => {
  it("is handed over whole for the slot's own width to cut, with the whole sentence on the row's hover text", async () => {
    // A sentence the runtime writes, longer than the row's room: the slot truncates it at the width the person
    // has, and the same string is the hover, so a wider sidebar reads more of it and none of it is decided here.
    const note = "putting the helper back on this machine";
    await mount(fakeApi([API], [status(API, { daemonNote: note })]), "api");
    const line = () => metaOf(rowOf("api"));
    await waitFor(() => expect(line().textContent).toBe(note));
    expect(line().className.split(" ")).toContain("truncate");
    expect(line().getAttribute("title")).toBe(note);
    // A line inside the room is left whole, and its title is the same words.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { daemonNote: "updating the helper" }) }));
    await waitFor(() => expect(line().textContent).toBe("updating the helper"));
    expect(line().getAttribute("title")).toBe("updating the helper");
    // A nap that saved no backup never takes this line: it is a note on a step already taken, and this slot is the
    // workspace's state and its spend. The verdict reads on the pane's own backup line.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { vaultedAt: "2026-09-08T07:10:04.444Z", vaultRefused: "the export was 646 MB, over the 200 MB cap" }) }));
    await waitFor(() => expect(line().textContent).not.toBe("updating the helper"));
    expect(rowOf("api").textContent).not.toContain("backup");
  });
});

describe("a window on another computer while the wsp it shows is asleep", () => {
  const served = (here: boolean) => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPath: "/ws", paired: here, version: "0.0.0", ...(here ? { wsPort: 7788, tokenHash: "a".repeat(64) } : {}) };
  };

  afterEach(() => {
    delete (window as unknown as { __WSP__?: unknown }).__WSP__;
  });

  it("reads the asleep line under the search row in the prose mono, never as an alert, and only on a page the host did not serve on this computer", async () => {
    served(false);
    await mount(fakeApi([API], [status(API)]), "api");
    expect(screen.queryByText(HOST_ASLEEP_LINE)).toBeNull();
    act(() => useStore.getState().setConn("reconnecting"));
    const line = await screen.findByText(HOST_ASLEEP_LINE);
    expect(line.closest("[data-sidebar-search]")).not.toBeNull();
    expect(line.className).toContain("font-mono");
    expect(line.className).not.toMatch(/border|bg-|destructive|warning/);
    expect(line.getAttribute("role")).toBeNull();
    // The rows stay as they were last known: the workspaces are on their own computers and keep working.
    expect(rowOf("api")).toBeDefined();
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(screen.queryByText(HOST_ASLEEP_LINE)).toBeNull());
  });

  it("no row carries a green whatever its machine is doing, and while this computer sleeps its row keeps an empty slot while a workspace at a provider keeps the word it was last known by", async () => {
    served(false);
    const MAC = { ...view("ws_mac", "this Mac"), kind: "local" as const };
    await mount(fakeApi([MAC, WEB], [status(MAC), status(WEB)]), "this Mac");
    await waitFor(() => expect(stateSlot(rowOf("web")).textContent).toBe("Stopped"));
    // The kind glyph and its green left the row: running is the resting state, and the word in the slot says the rest.
    expect(document.querySelector("[data-app-sidebar] .text-success-foreground, [data-sidebar-row] .text-success-foreground, .lucide-laptop, .lucide-cloud, .lucide-server")).toBeNull();
    act(() => useStore.getState().setConn("reconnecting"));
    await screen.findByText(HOST_ASLEEP_LINE);
    expect(stateSlot(rowOf("this Mac")).textContent).toBe("");
    // A workspace at a provider keeps running while that computer sleeps, so its row is left as it was.
    expect(stateSlot(rowOf("web")).textContent).toBe("Stopped");
    act(() => useStore.getState().setConn("live"));
  });

  it("says nothing of the kind on the computer the host runs on, where the page carries the host's own token", async () => {
    served(true);
    await mount(fakeApi([API], [status(API)]), "api");
    act(() => useStore.getState().setConn("reconnecting"));
    await waitFor(() => expect(useStore.getState().conn).toBe("reconnecting"));
    expect(screen.queryByText(HOST_ASLEEP_LINE)).toBeNull();
  });
});

describe("the project switcher", () => {
  /** Two projects, one on this computer and one on the box, each with a workspace, so a pick has something to hide. */
  const two = async () => {
    const api = fakeApi([API, { ...WEB, project: { id: "pr_2", name: "wsp", path: "/Users/dev/wsp", computer: "here" } }], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello", threadId: "thr_1" }), session("s2", "ws_b", { prompt: "world", threadId: "thr_2" })]);
    api.projectsList = vi.fn(async () => [...PROJECTS, HERE_PROJECT]);
    await mount(api, "api");
    await waitFor(() => expect(rowIds()).toContain("project:pr_2"));
    return api;
  };

  it("reads All projects at rest over one two-line project row per project, the computer over the name, and no gear on any row", async () => {
    await two();
    expect(head().textContent).toBe(SWITCHER_WORDS.all);
    expect(head().disabled).toBe(false);
    expect(head().getAttribute("aria-haspopup")).toBe("listbox");
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(head().querySelector("svg.lucide-folder")).not.toBeNull();
    expect(head().querySelector("svg.lucide-chevron-down")).not.toBeNull();
    expect(rowIds().filter(id => id?.startsWith("project:"))).toEqual(["project:pr_1", "project:pr_2"]);
    // Every project row is two lines: the computer it lives on small over its name, this computer by its own word.
    expect(rowOf("spoo-landing").dataset["lines"]).toBe("2");
    expect(rowOf("spoo-landing").querySelector("[data-project-computer]")!.textContent).toBe(BOX_NAME);
    expect(rowOf("spoo-landing").querySelector("[data-project-name]")!.textContent).toBe("spoo-landing");
    expect(rowOf("wsp").querySelector("[data-project-computer]")!.textContent).toBe(placeName(PLACES[0]!, true));
    expect(document.querySelector("[data-sidebar-search] svg.lucide-settings, [data-sidebar-tree] svg.lucide-settings")).toBeNull();
    // What a screen reader is given is what the face shows: the name, the computer, and the count while the row is shut.
    expect(rowOf("spoo-landing").getAttribute("aria-label")).toBe(`spoo-landing, ${BOX_NAME}`);
    expect(rowOf("wsp").getAttribute("aria-label")).toBe(`wsp, ${placeName(PLACES[0]!, true)}`);
    // The first click opens the project's home and leaves its workspaces showing; a click on the open home shuts it.
    fireEvent.click(rowOf("spoo-landing"));
    expect(useStore.getState().projectHome).toBe("pr_1");
    expect(rowOf("spoo-landing").getAttribute("aria-label")).toBe(`spoo-landing, ${BOX_NAME}`);
    fireEvent.click(rowOf("spoo-landing"));
    expect(rowOf("spoo-landing").getAttribute("aria-label")).toBe(`spoo-landing, ${BOX_NAME}, 1`);
    const count = rowOf("spoo-landing").querySelector<HTMLElement>("[data-project-count]")!;
    expect(count.textContent).toBe("1");
    expect(count.className).toContain("group-hover/menu-item:opacity-0");
  });

  it("opens on a click to a search field, All projects checked, one row per project and Add a project at the foot; typing filters the projects while the two ends stand", async () => {
    await two();
    fireEvent.click(head());
    expect(head().getAttribute("aria-expanded")).toBe("true");
    const list = within(menu()!);
    const options = () => list.getAllByRole("option").map(option => option.textContent);
    expect(options()).toEqual([SWITCHER_WORDS.all, `spoo-landing${BOX_NAME}`, "wsp"]);
    expect(list.getByRole("option", { name: SWITCHER_WORDS.all }).getAttribute("aria-selected")).toBe("true");
    expect(list.getByRole("option", { name: SWITCHER_WORDS.all }).querySelector("svg.lucide-check")).not.toBeNull();
    expect(list.getByRole("option", { name: /^wsp/ }).querySelector("svg.lucide-check")).toBeNull();
    expect(list.getByText(PROJECT_WORDS.add).closest("button")!.querySelector("svg.lucide-plus")).not.toBeNull();
    const field = list.getByLabelText(SWITCHER_WORDS.search) as HTMLInputElement;
    expect(field.placeholder).toBe(SWITCHER_WORDS.search);
    fireEvent.change(field, { target: { value: "SPOO" } });
    expect(options()).toEqual([SWITCHER_WORDS.all, `spoo-landing${BOX_NAME}`]);
    fireEvent.change(field, { target: { value: "nothing here" } });
    expect(options()).toEqual([SWITCHER_WORDS.all]);
    expect(list.getByText(PROJECT_WORDS.add)).toBeDefined();
    // No caps, no letter-spacing anywhere in the menu either.
    expect([...menu()!.querySelectorAll("*")].some(el => /uppercase|tracking-/.test(el.className))).toBe(false);
  });

  it("picking a project draws its workspaces alone with no project row, names it in the head with its plus on hover, remembers the pick in this window, and All projects brings every row back", async () => {
    await two();
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByRole("option", { name: /^wsp/ }));
    expect(menu()).toBeNull();
    expect(head().textContent).toBe("wsp");
    expect(head().getAttribute("aria-expanded")).toBe("false");
    // The tree starts at the project's workspaces: no project row, every depth one less.
    expect(rowIds()).toEqual(["ws:ws_b", "thread:thr_2"]);
    expect(depthOf(rowOf("web"))).toBe(0);
    expect(depthOf(rowOf("world"))).toBe(1);
    expect(window.localStorage.getItem("wsp:sidebar-project")).toBe('"pr_2"');
    // The head stands in for the project's row: its plus is New workspace on that project.
    const plus = head().parentElement!.querySelector<HTMLElement>("[data-k=new-workspace]")!;
    expect(plus.dataset["project"]).toBe("pr_2");
    expect(plus.getAttribute("aria-label")).toBe(NEW_WORKSPACE);
    // Nothing at rest at every width, the phone's sheet included, where the kit alone would stand it up.
    expect(plus.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    fireEvent.click(plus);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_2]")!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Back to every project: the rows return and the pick leaves this window's storage.
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByRole("option", { name: SWITCHER_WORDS.all }));
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "thread:thr_1", "project:pr_2", "ws:ws_b", "thread:thr_2"]);
    expect(window.localStorage.getItem("wsp:sidebar-project")).toBeNull();
    expect(head().parentElement!.querySelector("[data-k=new-workspace]")).toBeNull();
  });

  it("the keys walk the menu and stop there: ArrowDown moves the active row and names it to the field while focus stays on the field, Enter picks and shuts, and a stored pick for a project this host no longer holds reads as All projects", async () => {
    window.localStorage.setItem("wsp:sidebar-project", '"pr_gone"');
    await two();
    expect(head().textContent).toBe(SWITCHER_WORDS.all);
    expect(rowIds()).toContain("project:pr_1");
    fireEvent.click(head());
    const field = within(menu()!).getByLabelText(SWITCHER_WORDS.search) as HTMLInputElement;
    act(() => field.focus());
    const active = () => menu()!.querySelector<HTMLElement>("[data-active]")!;
    expect(active().textContent).toBe(SWITCHER_WORDS.all);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(active().textContent).toBe(`spoo-landing${BOX_NAME}`);
    // The key stops at the menu: the sidebar's own walk under it never takes focus off the field, and the field
    // names the row the keys are on.
    expect(document.activeElement).toBe(field);
    expect(active().id).not.toBe("");
    expect(field.getAttribute("aria-activedescendant")).toBe(active().id);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(active().textContent).toBe(PROJECT_WORDS.add);
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("aria-activedescendant")).toBe(active().id);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(menu()).toBeNull();
    expect(head().textContent).toBe("wsp");
    expect(rowIds()).toEqual(["ws:ws_b", "thread:thr_2"]);
    expect(document.activeElement).toBe(head());
  });

  it("while a project is picked the palette's New workspace opens the dialog on that project, as the head's plus does", async () => {
    await two();
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByRole("option", { name: /^wsp/ }));
    act(() => requestNewWorkspace());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_2]")!.getAttribute("aria-checked")).toBe("true");
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_1]")!.getAttribute("aria-checked")).toBe("false");
  });

  it("picking a project changes what the sidebar lists and nothing else: the selected thread stays open and the sidebar then draws no lifted row", async () => {
    await two();
    fireEvent.click(rowOf("hello"));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", selectedThreadId: "thr_1" });
    expect(document.querySelectorAll("[data-sidebar-row][data-active=true]")).toHaveLength(1);
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByRole("option", { name: /^wsp/ }));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", selectedThreadId: "thr_1" });
    expect(document.querySelectorAll("[data-sidebar-row][data-active=true]")).toHaveLength(0);
  });

  it("Add a project at the menu's foot opens the sheet, and no row at rest says it", async () => {
    await two();
    expect(screen.queryByText(PROJECT_WORDS.add)).toBeNull();
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByText(PROJECT_WORDS.add));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.dataset["k"]).toBe("add-project");
    expect(menu()).toBeNull();
  });
});

describe("the tree", () => {
  it("nests a spawned thread under its opener as deep as the opening went, a forked workspace under the thread that forked it with its threads one more in, and keeps an orphan at the workspace's thread depth", async () => {
    const fork = { ...view("ws_fork", "pricing table", "running", 30 * 60_000), parentThreadId: "th_build" };
    await mount(
      fakeApi(
        [API, fork],
        [status(API), status(fork)],
        [
          session("s1", "ws_a", { prompt: "retry the webhook queue", threadId: "th_lead", startedAt: iso(-60_000) }),
          session("s2", "ws_a", { prompt: "build the rows", threadId: "th_build", parentThreadId: "th_lead", startedBy: "agent", startedAt: iso(-50_000) }),
          session("s3", "ws_a", { prompt: "review the rows", threadId: "th_review", parentThreadId: "th_build", startedBy: "agent", startedAt: iso(-40_000), asking: "Write the review" }),
          session("s4", "ws_fork", { prompt: "move the pricing table", threadId: "th_move", parentThreadId: "th_build", startedBy: "agent", startedAt: iso(-30_000) }),
          session("s5", "ws_a", { prompt: "left behind", threadId: "th_orphan", parentThreadId: "th_nowhere", startedBy: "agent", startedAt: iso(-20_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("move the pricing table")).toBeDefined());
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "thread:th_orphan", "thread:th_lead", "thread:th_build", "thread:th_review", "ws:ws_fork", "thread:th_move"]);
    const depths = Object.fromEntries(rowIds().map(id => [id ?? "", Number(document.querySelector<HTMLElement>(`[data-row-id='${id}']`)!.dataset["depth"])]));
    expect(depths).toEqual({ "project:pr_1": 0, "ws:ws_a": 1, "thread:th_orphan": 2, "thread:th_lead": 2, "thread:th_build": 3, "thread:th_review": 4, "ws:ws_fork": 4, "thread:th_move": 5 });
    // Real nesting, item inside item: the builder's item holds the reviewer and the fork's whole block.
    const build = rowOf("build the rows").closest("li[data-thread-item]")!;
    expect(build.contains(rowOf("review the rows"))).toBe(true);
    expect(build.contains(rowOf("pricing table"))).toBe(true);
    expect(build.contains(rowOf("move the pricing table"))).toBe(true);
    expect(rowOf("retry the webhook queue").closest("li[data-thread-item]")!.contains(build)).toBe(true);
    // Every child list is a list with its rail, and every item in one is a rail item; the top list has none.
    for (const id of ["ws:ws_a", "thread:th_lead", "thread:th_build", "thread:th_review", "ws:ws_fork", "thread:th_move"]) {
      const item = document.querySelector<HTMLElement>(`[data-row-id='${id}']`)!.closest("li")!;
      expect(item.className, id).toContain("before:w-px");
      expect(item.parentElement!.className, id).toContain("ml-3");
    }
    expect(rowOf("spoo-landing").closest("li")!.className).not.toContain("before:w-px");
    expect(threadState(rowOf("review the rows"))).toBe("Needs you");
  });

  it("the working rows come first, then the settled rows, then the archive's fold, all at the workspace's thread depth", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { prompt: "working", threadId: "th_1", startedAt: iso(-60_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "idle", threadId: "th_2", startedAt: iso(-120_000), endedAt: iso(-100_000) }),
          session("s3", "ws_a", { status: "completed", prompt: "old", threadId: "th_3", startedAt: iso(-3 * 24 * 60 * 60_000), endedAt: iso(-2 * 24 * 60 * 60_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("idle")).toBeDefined());
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "thread:th_1", "thread:th_2", "archived:ws_a"]);
    const fold = document.querySelector<HTMLElement>("[data-row-id='archived:ws_a']")!;
    expect([depthOf(rowOf("working")), depthOf(rowOf("idle")), depthOf(fold)]).toEqual([2, 2, 2]);
    // The fold is a label over rows rather than a row: a plain button at a short height with no fill of its own,
    // the word in the prose ink, the count beside it only while shut, the chevron after it, no rule.
    expect(fold.tagName).toBe("BUTTON");
    expect(fold.dataset["sidebar"]).toBeUndefined();
    expect(fold.className).toContain("h-7");
    expect(fold.className).not.toMatch(/(^|\s)hover:bg-/);
    expect(fold.getAttribute("aria-label")).toBe("Archived 1");
    expect(fold.textContent).toBe("Archived1");
    expect(fold.querySelector("[data-group-word]")!.className).toContain("text-[var(--sidebar-prose)]");
    expect(fold.querySelector("[data-group-count]")!.className).toContain("text-[var(--top-row-meta)]");
    expect(fold.querySelector(".h-px, .bg-sidebar-border\\/60")).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-label")).toBe("Archived");
    expect(fold.querySelector("[data-group-count]")).toBeNull();
  });
});

describe("one lifted row", () => {
  it("exactly one row is active when a thread is selected, one when a workspace is selected with no thread, none when nothing is, and none when the selected thread sits in a shut archive", async () => {
    await mount(
      fakeApi(
        [API, WEB],
        [status(API), status(WEB)],
        [session("s1", "ws_a", { prompt: "hello", threadId: "thr_1" }), session("s2", "ws_a", { status: "completed", prompt: "done", threadId: "thr_2", startedAt: iso(-3 * 24 * 60 * 60_000), endedAt: iso(-2 * 24 * 60 * 60_000) })],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Archived 1" })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Archived 1" }));
    const lifted = () => [...document.querySelectorAll<HTMLElement>("[data-sidebar-row][data-active=true]")].map(row => row.dataset["rowId"]);
    act(() => useStore.getState().select(null));
    expect(lifted()).toEqual([]);
    fireEvent.click(rowOf("hello"));
    expect(lifted()).toEqual(["thread:thr_1"]);
    fireEvent.click(rowOf("web"));
    expect(lifted()).toEqual(["ws:ws_b"]);
    fireEvent.click(rowOf("done"));
    expect(lifted()).toEqual(["thread:thr_2"]);
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(lifted()).toEqual([]);
    // No card, no border, no shadow on any row: the fill on the one selected row is the only lift.
    for (const row of document.querySelectorAll<HTMLElement>("[data-sidebar-row]")) expect(row.className).not.toMatch(/(^|\s)(shadow[^\s]*|border-sidebar-border|bg-sidebar-control-surface)(\s|$)/);
  });
});

describe("the add roads", () => {
  it("at rest the sidebar holds one button named New thread and, per project row, one New workspace on hover; nothing at rest says Add a project", async () => {
    const api = fakeApi([API], [status(API)], [session("s1", "ws_a", { prompt: "hello" })]);
    api.projectsList = vi.fn(async () => [...PROJECTS, HERE_PROJECT]);
    await mount(api, "api");
    await waitFor(() => expect(rowIds()).toContain("project:pr_2"));
    expect(screen.getAllByRole("button", { name: "New thread" })).toHaveLength(1);
    const pluses = screen.getAllByRole("button", { name: NEW_WORKSPACE });
    expect(pluses.map(plus => [plus.dataset["k"], plus.dataset["project"]])).toEqual([["new-workspace", "pr_1"], ["new-workspace", "pr_2"]]);
    for (const plus of pluses) expect(plus.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    // The one glyph a row keeps at rest on a width with no pointer is the selected workspace row's chevron; the
    // rest of the hover glyphs, the chevron on every other row among them, are not drawn there, so none is a tap.
    const chevron = screen.getByRole("button", { name: "Collapse api" });
    expect(chevron.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(chevron.className).toContain("max-md:hidden");
    expect(chevron.className).toContain("max-md:peer-data-[active=true]/menu-button:flex");
    expect(chevron.className).toContain("max-md:peer-data-[active=true]/menu-button:opacity-100");
    for (const plus of pluses) {
      expect(plus.className).toContain("max-md:hidden");
      expect(plus.className).not.toContain("max-md:peer-data-[active=true]/menu-button:");
    }
    expect(document.querySelectorAll("svg.lucide-plus")).toHaveLength(2);
    expect(screen.queryByText(PROJECT_WORDS.add)).toBeNull();
    expect(screen.queryByText(/ADD A PROJECT/)).toBeNull();
  });
});

describe("the creation row", () => {
  it("is two lines at the workspace row's height: the spinner in the lead, the name, the stage line cut with the whole on hover; a failed create is the word Failed in the slot and no dot", async () => {
    await mount(fakeApi([COPIED], [status(COPIED)]), "api");
    const long = "Forking the image, which takes a moment on a computer that has never made a copy of this project before.";
    act(() =>
      useStore.setState({
        creations: [
          { key: "creating:1", name: "beta", askedAt: Date.now(), project: "pr_1", workspaceId: null, lines: [{ stage: "fork-requested", message: long, at: "t", elapsedMs: 0 }], failed: null },
          { key: "creating:2", name: "gamma", askedAt: Date.now(), project: "pr_1", workspaceId: null, lines: [], failed: { title: "Could not create the workspace", detail: "the disk is full" } },
        ],
      } as never),
    );
    const beta = rowOf("beta");
    const gamma = rowOf("gamma");
    expect(rowIds()).toEqual(["project:pr_1", "ws:ws_a", "creating:1", "creating:2"]);
    for (const row of [beta, gamma]) {
      expect([...row.classList].filter(c => /^(h-|py-)/.test(c)).sort()).toEqual(["h-13", "py-0"]);
      const shape = (el: HTMLElement) => [...el.classList].filter(c => /^(h-|py-|px-|rounded-|text-\[|items-|gap-)/.test(c)).sort();
      expect(shape(row)).toEqual(shape(rowOf("api")));
      expect(row.querySelector(".rounded-full, .bg-destructive")).toBeNull();
    }
    expect(beta.getAttribute("aria-busy")).toBe("true");
    expect(beta.firstElementChild!.querySelector("svg")).not.toBeNull();
    expect(beta.querySelector("[data-creation-state]")!.textContent).toBe("");
    const line = beta.querySelector<HTMLElement>("[data-creation-line]")!;
    expect(line.textContent).toBe(long);
    expect(line.getAttribute("title")).toBe(long);
    expect(line.className).toContain("truncate");
    expect(gamma.getAttribute("aria-busy")).toBeNull();
    expect(gamma.firstElementChild!.querySelector("svg")).toBeNull();
    expect(gamma.querySelector("[data-creation-state]")!.textContent).toBe("Failed");
    expect(gamma.querySelector("[data-creation-state]")!.className).toContain("text-[var(--sidebar-prose)]");
    expect(gamma.querySelector("[data-creation-line]")!.textContent).toBe("Could not create the workspace");
  });
});
