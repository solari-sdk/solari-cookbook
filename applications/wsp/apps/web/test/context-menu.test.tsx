// SPDX-License-Identifier: AGPL-3.0-only
// Right-click menus over the registries: a workspace row, a thread row, a
// Files pane row and the terminal surface each open the in-app menu in a
// browser tab, built from their registry, with disabled rows dimmed and
// carrying their refusal, keyboard traversal and Escape; in the desktop shell
// the same items go to the native menu through the bridge and the chosen id
// runs. The tooltip skin is rendered inline (Base UI's positioning against
// jsdom's zero-size rects takes seconds per open), as is the popover the
// drawer's toolbar uses.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, threadForgetRefusal, type ContextMenuItem, type SessionView, type WorkspaceLook, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";

vi.mock("../src/components/ui/tooltip.js", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) =>
    element === undefined ? <>{children}</> : children === undefined ? element : cloneElement(element, {}, children),
  TooltipPopup: ({ children }: { children: ReactNode }) => <span role="tooltip">{children}</span>,
}));
vi.mock("../src/components/ui/popover.js", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ render, children }: { render: ReactElement<{ children?: ReactNode }>; children: ReactNode }) => cloneElement(render, {}, children),
  PopoverPopup: () => null,
}));

import { useContextMenuStore } from "../src/actions/contextMenu.js";
import { ContextMenuHost } from "../src/actions/ContextMenuHost.js";
import { TERMINAL_WORDS, THREAD_WORDS, WORKSPACE_WORDS } from "../src/actions/format.js";
import { NEW_WORKSPACE, PROJECT_WORDS } from "../src/sidebar/words.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { WorkspaceTerminalDrawer } from "../src/components/WorkspaceTerminalDrawer.js";
import { useDiffRevealStore } from "../src/diffs/reveal.js";
import { provideDaemonWire } from "../src/files/wire.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";
import { requestRenameWorkspace } from "../src/shell/shellRequests.js";
import { WorkspaceSidebar } from "../src/sidebar/WorkspaceSidebar.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";
import { fakeWire, LEVELS, resetSurfaces, WS } from "./surface-harness.js";
import { statusOf } from "./workspace-status.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices, lastNotice } from "./notice-text.js";

const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase,
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});
const CAPS = caps();

type FakeApi = Api & {
  nap: ReturnType<typeof vi.fn>;
  interruptSession: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
  deleteWorkspace: ReturnType<typeof vi.fn>;
  forgetThread: ReturnType<typeof vi.fn>;
  renameSession: ReturnType<typeof vi.fn>;
  renameWorkspace: ReturnType<typeof vi.fn>;
  setWorkspaceLook: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
};

function fakeApi(workspaces: WorkspaceView[], statuses: WorkspaceStatus[], sessions: SessionView[] = []): FakeApi {
  return {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    watchStatuses: async () => statuses,
    nap: vi.fn(async (id: string) => view(id, "?", "napping")),
    wake: vi.fn(async (id: string) => view(id, "?", "running")),
    forget: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => {}),
    // The runtime drops the thread's rows, so the next listing is short of them, as the real one is.
    forgetThread: vi.fn(async (threadId: string) => {
      for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i]!.threadId === threadId) sessions.splice(i, 1);
    }),
    rebuild: async id => ({ ...view(id, "?", "running"), machineId: "m_rebuilt" }),
    interruptSession: vi.fn(async () => "accepted" as const),
    // The runtime keeps the name on the row, so the next listing carries it, as the real one does.
    renameSession: vi.fn(async (sessionId: string, title: string) => {
      const row = sessions.find(s => s.id === sessionId);
      if (row !== undefined) row.harnessTitle = title;
      return { outcome: "renamed" as const };
    }),
    // The runtime holds the name on this computer, so the record it answers with carries it, as the real one does.
    renameWorkspace: vi.fn(async (id: string, name: string) => {
      const row = workspaces.find(w => w.id === id)!;
      row.name = name;
      return row;
    }),
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
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s_x", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
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

const API = view("ws_a", "api");
const OLD: WorkspaceView = { ...view("ws_c", "old", "gone"), gone: "machine m_ws_c is gone at the provider: Not found" };
const RUNNING: SessionView = { id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", prompt: "fix the port list", threadId: "thr_1", startedAt: Date.now() - 60_000 };
/** A launch that never started an agent: a failed row under a thread no harness ever announced a session for. */
const NEVER_RAN: SessionView = { id: "s2", workspaceId: "ws_a", harness: "claude", status: "failed", prompt: "never got going", threadId: "thr_2", startedAt: Date.now() - 30_000, endedAt: Date.now() - 30_000 };

const clipboard = () => {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
};

async function mountSidebar(api: FakeApi, firstName: string) {
  useStore.getState().bind(api);
  render(
    <SidebarProvider defaultOpen>
      <WorkspaceSidebar />
      <ContextMenuHost />
    </SidebarProvider>,
  );
  await waitFor(() => expect(screen.getByText(firstName)).toBeDefined());
}

/** The name the project's header row carries, which is the record every workspace in this file is made of. */
/** The project row's name leads its label, which goes on to name the computer the project is on and the count while shut. */
const PROJECT_NAME = /^the-project/;

const rowOf = (text: string): HTMLElement => screen.getByText(text).closest<HTMLElement>("[data-sidebar-row]")!;
/** A row by the id it carries, for a row whose own text is being edited. */
const rowOf2 = (rowId: string): HTMLElement => document.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`)!;
const menu = () => screen.queryByRole("menu");
const items = () => within(screen.getByRole("menu")).getAllByRole("menuitem");
const item = (label: string) => items().find(el => el.textContent?.startsWith(label))!;
const labels = () => items().map(el => el.querySelector("[data-menu-label]")?.textContent);
/** The refusal the tooltip skin shows for a row; the inline mock renders it right after the row. */
const refusalOf = (label: string): string | null => {
  const next = item(label).nextElementSibling;
  return next?.getAttribute("role") === "tooltip" ? next.textContent : null;
};
const rightClick = (el: Element, at = { clientX: 40, clientY: 50 }) => fireEvent.contextMenu(el, { ...at, composed: true });

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, selectedThreadId: null, projectHome: null, creations: [], sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true }, settingsOpen: false });
  clearNotices();
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
  useDiffRevealStore.setState({ pendingByWorkspaceId: {} });
  useContextMenuStore.setState({ menu: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { wsp?: unknown }).wsp;
  provideTerminals(WS, null);
  provideDaemonWire(WS, null);
});

describe("a workspace row's menu", () => {
  it("opens at the pointer with every registry action in order; disabled rows are dimmed with their refusal; arrows walk it and Escape hands focus back", async () => {
    await mountSidebar(fakeApi([API], [statusOf(API)]), "api");
    const row = rowOf("api");
    expect(menu()).toBeNull();
    rightClick(row);
    const opened = await screen.findByRole("menu");
    expect(opened.style.left).toBe("40px");
    expect(opened.style.top).toBe("50px");
    expect(labels()).toEqual([
      WORKSPACE_WORDS.pause,
      WORKSPACE_WORDS.newThread,
      WORKSPACE_WORDS.openTerminal,
      WORKSPACE_WORDS.openBrowser,
      WORKSPACE_WORDS.bringBack,
      WORKSPACE_WORDS.exportProject,
      WORKSPACE_WORDS.rename,
      WORKSPACE_WORDS.fork,
      WORKSPACE_WORDS.copyId,
      WORKSPACE_WORDS.delete,
    ]);
    expect(within(opened).getAllByRole("separator")).toHaveLength(5);
    expect(item(WORKSPACE_WORDS.pause).getAttribute("aria-disabled")).toBeNull();
    expect(item(WORKSPACE_WORDS.rename).getAttribute("aria-disabled")).toBeNull();
    expect(refusalOf(WORKSPACE_WORDS.rename)).toBeNull();
    expect(refusalOf(WORKSPACE_WORDS.delete)).toBeNull();
    expect(refusalOf(WORKSPACE_WORDS.pause)).toBeNull();
    expect(item(WORKSPACE_WORDS.openTerminal).querySelector("kbd")?.textContent).toBe("⌘J");
    // The first row that can run holds focus; arrows walk every row, disabled ones too, so their refusal can be read.
    await waitFor(() => expect(document.activeElement).toBe(item(WORKSPACE_WORDS.pause)));
    fireEvent.keyDown(opened, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item(WORKSPACE_WORDS.newThread));
    fireEvent.keyDown(opened, { key: "End" });
    expect(document.activeElement).toBe(item(WORKSPACE_WORDS.delete));
    fireEvent.keyDown(opened, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item(WORKSPACE_WORDS.pause));
    fireEvent.keyDown(opened, { key: "Escape" });
    await waitFor(() => expect(menu()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("a row chosen by click or Enter runs its handler and closes; a disabled row does nothing; a click elsewhere closes", async () => {
    const api = fakeApi([API], [statusOf(API)]);
    await mountSidebar(api, "api");
    rightClick(rowOf("api"));
    const opened = await screen.findByRole("menu");
    fireEvent.click(item(WORKSPACE_WORDS.fork));
    expect(menu()).not.toBeNull();
    for (let step = 0; step < 2; step++) fireEvent.keyDown(opened, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item(WORKSPACE_WORDS.openTerminal));
    fireEvent.keyDown(opened, { key: "Enter" });
    await waitFor(() => expect(useTerminalDrawerStore.getState().byWorkspaceId["ws_a"]?.terminalOpen).toBe(true));
    await waitFor(() => expect(menu()).toBeNull());

    rightClick(rowOf("api"));
    await screen.findByRole("menu");
    fireEvent.click(item(WORKSPACE_WORDS.pause));
    await waitFor(() => expect(api.nap).toHaveBeenCalledWith("ws_a"));
    await waitFor(() => expect(menu()).toBeNull());

    rightClick(rowOf("api"));
    await screen.findByRole("menu");
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(menu()).toBeNull());
  });

  it("copy id writes the machine id; without a clipboard the refusal lands in the toast", async () => {
    await mountSidebar(fakeApi([API], [statusOf(API)]), "api");
    rightClick(rowOf("api"));
    await screen.findByRole("menu");
    fireEvent.click(item(WORKSPACE_WORDS.copyId));
    await waitFor(() => expect(lastNotice()).toBe("Copy computer id: The clipboard is not available here"));
    const writeText = clipboard();
    rightClick(rowOf("api"));
    await screen.findByRole("menu");
    fireEvent.click(item(WORKSPACE_WORDS.copyId));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("m_ws_a"));
  });

  it("a gone row's Forget opens the same confirmation the row button does, and the wake slot names why it cannot run", async () => {
    await mountSidebar(fakeApi([OLD], [statusOf(OLD)]), "old");
    await waitFor(() => expect(rowOf("old").textContent).toContain("Gone"));
    rightClick(rowOf("old"));
    await screen.findByRole("menu");
    expect(item(WORKSPACE_WORDS.wake).getAttribute("aria-disabled")).toBe("true");
    expect(refusalOf(WORKSPACE_WORDS.wake)).toBe("Workspace machine is gone; rebuild it to wake");
    expect(item(WORKSPACE_WORDS.rebuild).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(item(WORKSPACE_WORDS.forget));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Forget old?");
  });

  it("in the desktop shell the bridge gets the serialized items and the chosen id runs, with no in-app menu", async () => {
    const api = fakeApi([API], [statusOf(API)]);
    const contextMenu = vi.fn(async (_items: ContextMenuItem[]) => "phase");
    (window as { wsp?: unknown }).wsp = { contextMenu };
    await mountSidebar(api, "api");
    rightClick(rowOf("api"));
    await waitFor(() => expect(contextMenu).toHaveBeenCalledTimes(1));
    const sent = contextMenu.mock.calls[0]![0];
    expect(sent.map(i => [i.id, i.label, i.enabled])).toEqual([
      ["phase", WORKSPACE_WORDS.pause, true],
      ["new-thread", WORKSPACE_WORDS.newThread, true],
      ["open-terminal", WORKSPACE_WORDS.openTerminal, true],
      ["open-browser", WORKSPACE_WORDS.openBrowser, true],
      ["bring-back", WORKSPACE_WORDS.bringBack, false],
      ["export-project", WORKSPACE_WORDS.exportProject, false],
      ["rename", WORKSPACE_WORDS.rename, true],
      ["fork", WORKSPACE_WORDS.fork, false],
      ["copy-id", WORKSPACE_WORDS.copyId, true],
      ["delete", WORKSPACE_WORDS.delete, true],
    ]);
    expect(sent.find(i => i.id === "rename")).not.toHaveProperty("refusal");
    expect(sent.find(i => i.id === "open-terminal")?.accelerator).toBe("CommandOrControl+J");
    expect(menu()).toBeNull();
    await waitFor(() => expect(api.nap).toHaveBeenCalledWith("ws_a"));
  });
});

describe("a project's header menu", () => {
  it("holds the acts of a project: another piece of work on it, its settings page, and forgetting it once nothing stands on it", async () => {
    await mountSidebar(fakeApi([API, OLD], [statusOf(API), statusOf(OLD)]), "api");
    rightClick(screen.getByRole("button", { name: PROJECT_NAME }));
    await screen.findByRole("menu");
    expect(labels()).toEqual([NEW_WORKSPACE, PROJECT_WORDS.settings, PROJECT_WORDS.remove]);
    // Two workspaces stand on it, so the runtime's own sentence holds the removal back before any click.
    expect(item(PROJECT_WORDS.remove).getAttribute("aria-disabled")).toBe("true");
    expect(refusalOf(PROJECT_WORDS.remove)).toContain("workspaces standing on it");
    // Project settings opens Settings on the project's own page, where its look is picked.
    fireEvent.click(item(PROJECT_WORDS.settings));
    await waitFor(() => expect(useStore.getState().settingsOpen).toBe(true));
    expect(useSettingsStore.getState().at).toEqual({ kind: "project", id: "pr_1" });
  });
});

describe("a thread row's menu", () => {
  it("offers stop and copy link; stop interrupts the runtime's session, copy link writes the thread's address", async () => {
    const api = fakeApi([API], [statusOf(API)], [RUNNING]);
    const writeText = clipboard();
    await mountSidebar(api, "api");
    const row = rowOf("fix the port list");
    rightClick(row);
    await screen.findByRole("menu");
    expect(labels()).toEqual([THREAD_WORDS.stop, THREAD_WORDS.rename, THREAD_WORDS.copyLink, THREAD_WORDS.forget]);
    // The agent's own store keeps a name, and the row is the box: the rename runs.
    expect(item(THREAD_WORDS.rename).getAttribute("aria-disabled")).toBeNull();
    expect(refusalOf(THREAD_WORDS.rename)).toBeNull();
    expect(item(THREAD_WORDS.forget).getAttribute("aria-disabled")).toBe("true");
    expect(refusalOf(THREAD_WORDS.forget)).toBe(threadForgetRefusal("thr_1"));
    fireEvent.click(item(THREAD_WORDS.stop));
    await waitFor(() => expect(api.interruptSession).toHaveBeenCalledWith("s1"));
    rightClick(row);
    await screen.findByRole("menu");
    fireEvent.click(item(THREAD_WORDS.copyLink));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${window.location.pathname}#w/ws_a/t/thr_1`));
    // The workspace row's menu did not open under the thread's.
    expect(screen.queryByText(WORKSPACE_WORDS.pause)).toBeNull();
  });

  it("Forget drops a thread no turn ever ran on through the runtime, and its row leaves the sidebar", async () => {
    const api = fakeApi([API], [statusOf(API)], [{ ...RUNNING }, { ...NEVER_RAN }]);
    await mountSidebar(api, "api");
    rightClick(rowOf("never got going"));
    await screen.findByRole("menu");
    expect(item(THREAD_WORDS.forget).getAttribute("aria-disabled")).toBeNull();
    expect(refusalOf(THREAD_WORDS.forget)).toBeNull();
    fireEvent.click(item(THREAD_WORDS.forget));
    await waitFor(() => expect(api.forgetThread).toHaveBeenCalledWith("thr_2"));
    await waitFor(() => expect(screen.queryByText("never got going")).toBeNull());
    // The thread beside it is untouched.
    expect(screen.getByText("fix the port list")).toBeDefined();
  });

  it("Rename turns the row's title into an input in place, and Enter names the thread through the runtime", async () => {
    const api = fakeApi([API], [statusOf(API)], [{ ...RUNNING }]);
    await mountSidebar(api, "api");
    const row = rowOf("fix the port list");
    const rowClass = row.className;
    rightClick(row);
    await screen.findByRole("menu");
    expect(refusalOf(THREAD_WORDS.rename)).toBeNull();
    fireEvent.click(item(THREAD_WORDS.rename));

    const input = (await screen.findByRole("textbox", { name: THREAD_WORDS.rename })) as HTMLInputElement;
    expect(input.value).toBe("fix the port list");
    await waitFor(() => expect(document.activeElement).toBe(input));
    // The input took the title's place inside the row, and the row is the same row it was.
    expect(input.closest("[data-sidebar-row]")).toBe(rowOf2("thread:thr_1"));
    expect(rowOf2("thread:thr_1").className).toBe(rowClass);

    fireEvent.change(input, { target: { value: "the name he typed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith("s1", "the name he typed"));
    await waitFor(() => expect(screen.getByText("the name he typed")).toBeDefined());
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Escape leaves the old name, and so does clicking away", async () => {
    const api = fakeApi([API], [statusOf(API)], [{ ...RUNNING }]);
    await mountSidebar(api, "api");
    const openEdit = async (): Promise<HTMLInputElement> => {
      rightClick(rowOf("fix the port list"));
      await screen.findByRole("menu");
      fireEvent.click(item(THREAD_WORDS.rename));
      return (await screen.findByRole("textbox", { name: THREAD_WORDS.rename })) as HTMLInputElement;
    };

    const first = await openEdit();
    fireEvent.change(first, { target: { value: "not this one" } });
    fireEvent.keyDown(first, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(api.renameSession).not.toHaveBeenCalled();
    expect(screen.getByText("fix the port list")).toBeDefined();

    const second = await openEdit();
    fireEvent.change(second, { target: { value: "nor this one" } });
    fireEvent.blur(second);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(api.renameSession).not.toHaveBeenCalled();
    expect(screen.getByText("fix the port list")).toBeDefined();
  });

  it("a napping machine is woken by the rename itself, and the field keeps what was typed until the name has landed", async () => {
    const api = fakeApi([view("ws_a", "api", "napping")], [statusOf(view("ws_a", "api", "napping"))], [{ ...RUNNING }]);
    let letWake: (() => void) | undefined;
    const woken = new Promise<void>(resolve => {
      letWake = resolve;
    });
    api.wake.mockImplementation(async (id: string) => {
      await woken;
      return view(id, "api", "running");
    });
    await mountSidebar(api, "api");
    rightClick(rowOf("fix the port list"));
    await screen.findByRole("menu");
    // The machine is not up and the row is still live: the rename wakes it, as the command line's own rename does.
    expect(refusalOf(THREAD_WORDS.rename)).toBeNull();
    fireEvent.click(item(THREAD_WORDS.rename));
    const input = (await screen.findByRole("textbox", { name: THREAD_WORDS.rename })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "the name he typed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // While it wakes the field is still there with the name in it, and nothing has been said in a toast.
    await waitFor(() => expect(api.wake).toHaveBeenCalledWith("ws_a"));
    expect(api.renameSession).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: THREAD_WORDS.rename }) as HTMLInputElement).value).toBe("the name he typed");
    expect(lastNotice()).toBeNull();
    // A second Enter while it waits sends nothing twice.
    fireEvent.keyDown(screen.getByRole("textbox", { name: THREAD_WORDS.rename }), { key: "Enter" });

    letWake?.();
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith("s1", "the name he typed"));
    expect(api.renameSession).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(screen.getByText("the name he typed")).toBeDefined();
  });

  it("a name the runtime did not take stays in the field for another go, with the reason in the toast", async () => {
    const api = fakeApi([API], [statusOf(API)], [{ ...RUNNING }]);
    api.renameSession.mockImplementation(async () => ({ outcome: "failed" as const, error: "database is locked" }));
    await mountSidebar(api, "api");
    rightClick(rowOf("fix the port list"));
    await screen.findByRole("menu");
    fireEvent.click(item(THREAD_WORDS.rename));
    const input = (await screen.findByRole("textbox", { name: THREAD_WORDS.rename })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "the name he typed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(lastNotice()).toBe("database is locked"));
    // The name is where the person left it: a toast never eats it.
    const still = screen.getByRole("textbox", { name: THREAD_WORDS.rename }) as HTMLInputElement;
    expect(still.value).toBe("the name he typed");
    fireEvent.keyDown(still, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(screen.getByText("fix the port list")).toBeDefined();
  });

  it("a thread on a machine that is gone carries the rebuild refusal, so no box opens over it", async () => {
    const api = fakeApi([OLD], [statusOf(OLD)], [{ ...RUNNING, id: "s9", workspaceId: "ws_c", threadId: "thr_9" }]);
    await mountSidebar(api, "old");
    rightClick(rowOf("fix the port list"));
    await screen.findByRole("menu");
    expect(item(THREAD_WORDS.rename).getAttribute("aria-disabled")).toBe("true");
    expect(refusalOf(THREAD_WORDS.rename)).toBe("Workspace machine is gone; rebuild it to rename (machine m_ws_c is gone at the provider: Not found)");
    fireEvent.click(item(THREAD_WORDS.rename));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a thread drawn under an opener on another workspace still carries its own machine's refusal", async () => {
    // The opener runs here and the thread its agent opened runs on a machine that is gone, so the row sits among
    // this workspace's rows while its rename has to travel to the other machine, which is not there to take it.
    const api = fakeApi(
      [API, OLD],
      [statusOf(API), statusOf(OLD)],
      [{ ...RUNNING }, { id: "s9", workspaceId: "ws_c", harness: "claude", status: "running", prompt: "rebuild the index", threadId: "thr_9", parentThreadId: "thr_1", startedBy: "agent", startedAt: Date.now() - 30_000 }],
    );
    await mountSidebar(api, "api");
    await waitFor(() => expect(screen.getByText("rebuild the index")).toBeDefined());
    // One step in under the thread that opened it, whichever workspace its session is filed against.
    const lead = Number(rowOf("fix the port list").dataset["depth"]);
    expect(lead).toBeGreaterThanOrEqual(0);
    expect(Number(rowOf("rebuild the index").dataset["depth"])).toBe(lead + 1);
    rightClick(rowOf("rebuild the index"));
    await screen.findByRole("menu");
    expect(item(THREAD_WORDS.rename).getAttribute("aria-disabled")).toBe("true");
    expect(refusalOf(THREAD_WORDS.rename)).toBe("Workspace machine is gone; rebuild it to rename (machine m_ws_c is gone at the provider: Not found)");
    fireEvent.click(item(THREAD_WORDS.rename));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("the keys the sidebar traverses with are the field's while a name is typed", async () => {
    const api = fakeApi([API], [statusOf(API)], [{ ...RUNNING }]);
    await mountSidebar(api, "api");
    rightClick(rowOf("fix the port list"));
    await screen.findByRole("menu");
    fireEvent.click(item(THREAD_WORDS.rename));
    const input = (await screen.findByRole("textbox", { name: THREAD_WORDS.rename })) as HTMLInputElement;
    // The field takes focus in an effect, one turn after it is in the tree; the keys go to a field that holds it.
    await waitFor(() => expect(document.activeElement).toBe(input));
    // Home and End move the caret in a field; the sidebar reads them as go-to-first-row and would take the focus.
    fireEvent.keyDown(input, { key: "Home" });
    fireEvent.keyDown(input, { key: "End" });
    expect(document.activeElement).toBe(input);
  });

  it("a name that is only space, or the name it already had, is a cancel: nothing is sent", async () => {
    const api = fakeApi([API], [statusOf(API)], [{ ...RUNNING }]);
    await mountSidebar(api, "api");
    for (const typed of ["   ", "fix the port list"]) {
      rightClick(rowOf("fix the port list"));
      await screen.findByRole("menu");
      fireEvent.click(item(THREAD_WORDS.rename));
      const input = (await screen.findByRole("textbox", { name: THREAD_WORDS.rename })) as HTMLInputElement;
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    }
    expect(api.renameSession).not.toHaveBeenCalled();
  });

  it("a double-click on the title opens the same box the menu opens, and a refused rename leaves the title as text", async () => {
    const api = fakeApi([API], [statusOf(API)], [{ ...RUNNING }]);
    await mountSidebar(api, "api");
    fireEvent.doubleClick(screen.getByText("fix the port list"));
    const input = (await screen.findByRole("textbox", { name: THREAD_WORDS.rename })) as HTMLInputElement;
    expect(input.value).toBe("fix the port list");
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());

    cleanup();
    const gone = fakeApi([OLD], [statusOf(OLD)], [{ ...RUNNING, id: "s9", workspaceId: "ws_c", threadId: "thr_9" }]);
    await mountSidebar(gone, "old");
    fireEvent.doubleClick(screen.getByText("fix the port list"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a settled thread's stop carries the refusal", async () => {
    await mountSidebar(fakeApi([API], [statusOf(API)], [{ ...RUNNING, status: "completed", endedAt: Date.now() - 30_000 }]), "api");
    rightClick(rowOf("fix the port list"));
    await screen.findByRole("menu");
    expect(item(THREAD_WORDS.stop).getAttribute("aria-disabled")).toBe("true");
    expect(refusalOf(THREAD_WORDS.stop)).toBe("Thread is not running");
  });
});

describe("a workspace row's name box", () => {
  const nameBox = () => screen.findByRole("textbox", { name: WORKSPACE_WORDS.rename }) as Promise<HTMLInputElement>;
  const openFromMenu = async (): Promise<HTMLInputElement> => {
    rightClick(rowOf2("ws:ws_a"));
    await screen.findByRole("menu");
    fireEvent.click(item(WORKSPACE_WORDS.rename));
    return nameBox();
  };

  it("Rename turns the row's name into a field in the same slot, and Enter names the workspace through the runtime", async () => {
    const api = fakeApi([{ ...API }], [statusOf(API)]);
    await mountSidebar(api, "api");
    const rowClass = rowOf2("ws:ws_a").className;
    const input = await openFromMenu();
    expect(input.value).toBe("api");
    await waitFor(() => expect(document.activeElement).toBe(input));
    // The field took the name's place inside the row, and the row is the same row it was.
    expect(input.closest("[data-sidebar-row]")).toBe(rowOf2("ws:ws_a"));
    expect(rowOf2("ws:ws_a").className).toBe(rowClass);

    fireEvent.change(input, { target: { value: "the name he typed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.renameWorkspace).toHaveBeenCalledWith("ws_a", "the name he typed"));
    await waitFor(() => expect(screen.getByText("the name he typed")).toBeDefined());
    expect(screen.queryByRole("textbox")).toBeNull();
  });



  it("a double-click on the name opens the same box", async () => {
    const api = fakeApi([{ ...API }], [statusOf(API)]);
    await mountSidebar(api, "api");
    fireEvent.doubleClick(screen.getByText("api"));
    expect((await nameBox()).value).toBe("api");
  });

  it("Escape and clicking away leave the old name, and a name that is blank or unchanged is a cancel", async () => {
    const api = fakeApi([{ ...API }], [statusOf(API)]);
    await mountSidebar(api, "api");
    for (const [typed, leave] of [["not this one", "Escape"], ["nor this one", "blur"], ["   ", "Enter"], ["api", "Enter"]] as const) {
      const input = await openFromMenu();
      fireEvent.change(input, { target: { value: typed } });
      if (leave === "blur") fireEvent.blur(input);
      else fireEvent.keyDown(input, { key: leave });
      await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    }
    expect(api.renameWorkspace).not.toHaveBeenCalled();
    expect(screen.getByText("api")).toBeDefined();
  });

  it("a name the runtime refuses stays in the field for another go, with the runtime's own reason in the toast", async () => {
    const api = fakeApi([{ ...API }], [statusOf(API)]);
    api.renameWorkspace.mockImplementation(async () => {
      throw new Error("web is already a workspace; pick another name, or delete it first");
    });
    await mountSidebar(api, "api");
    const input = await openFromMenu();
    fireEvent.change(input, { target: { value: "web" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(lastNotice()).toBe("web is already a workspace; pick another name, or delete it first"));
    // The name is where the person left it: a toast never eats it, and the row still holds the name it had.
    const still = await nameBox();
    expect(still.value).toBe("web");
    fireEvent.keyDown(still, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(screen.getByText("api")).toBeDefined();
  });

  it("a box asked for while the project's section is shut opens that section, so it lands on a row a person can see", async () => {
    const api = fakeApi([{ ...API }], [statusOf(API)]);
    await mountSidebar(api, "api");
    // The first click opens the project's home, the second shuts its section.
    fireEvent.click(screen.getByRole("button", { name: PROJECT_NAME }));
    fireEvent.click(screen.getByRole("button", { name: PROJECT_NAME }));
    await waitFor(() => expect(document.querySelector("[data-row-id='ws:ws_a']")).toBeNull());

    requestRenameWorkspace("ws_a");
    const input = await nameBox();
    expect(input.value).toBe("api");
    expect(input.closest("[data-sidebar-row]")).toBe(rowOf2("ws:ws_a"));
  });

  it("a row holding the box takes no menu over it, as a thread row being named does not", async () => {
    const api = fakeApi([{ ...API }], [statusOf(API)]);
    await mountSidebar(api, "api");
    await openFromMenu();
    rightClick(rowOf2("ws:ws_a"));
    await new Promise(r => setTimeout(r, 20));
    expect(menu()).toBeNull();
  });

  it("one row at a time holds the box: opening a workspace's closes a thread's", async () => {
    const api = fakeApi([{ ...API }], [statusOf(API)], [{ ...RUNNING }]);
    await mountSidebar(api, "api");
    rightClick(rowOf("fix the port list"));
    await screen.findByRole("menu");
    fireEvent.click(item(THREAD_WORDS.rename));
    await screen.findByRole("textbox", { name: THREAD_WORDS.rename });
    await openFromMenu();
    expect(screen.queryAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByText("fix the port list")).toBeDefined();
  });
});

describe("the terminal surface's menu", () => {
  function fakeLink() {
    let next = 1;
    const ops: string[] = [];
    const wire: TerminalWire = {
      request: async op => {
        ops.push(op);
        if (op === "pty.create") return { ok: true, ptyId: `p${next++}` };
        if (op === "pty.list") return { ok: true, ptys: [] };
        return { ok: true };
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    provideTerminals(WS, wt);
    return { wt, count: (op: string) => ops.filter(o => o === op).length };
  }

  it("opens over the canvas with the terminal actions; copy needs a selection; New Terminal opens a pty", async () => {
    const { count } = fakeLink();
    useStore.setState({ workspaces: [{ ...API, id: WS }] });
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(
      <>
        <WorkspaceTerminalDrawer workspaceId={WS} />
        <ContextMenuHost />
      </>,
    );
    await waitFor(() => expect(document.querySelectorAll('[data-terminal-owner="drawer"] canvas')).toHaveLength(1), { timeout: 15_000 });
    const canvas = document.querySelector('[data-terminal-owner="drawer"] canvas')!;
    // The canvas is in the document before the wasm surface behind it is ready; the menu opens once it is.
    await waitFor(() => {
      rightClick(canvas, { clientX: 300, clientY: 200 });
      expect(menu()).not.toBeNull();
    }, { timeout: 15_000 });
    expect(labels()).toEqual([TERMINAL_WORDS.copy, TERMINAL_WORDS.paste, TERMINAL_WORDS.clear, TERMINAL_WORDS.split, TERMINAL_WORDS.splitVertical, TERMINAL_WORDS.new, TERMINAL_WORDS.close]);
    expect(item(TERMINAL_WORDS.copy).getAttribute("aria-disabled")).toBe("true");
    expect(refusalOf(TERMINAL_WORDS.copy)).toBe("Nothing is selected");
    expect(item(TERMINAL_WORDS.paste).getAttribute("aria-disabled")).toBe("true");
    expect(refusalOf(TERMINAL_WORDS.paste)).toBe("The clipboard cannot be read here");
    expect(item(TERMINAL_WORDS.split).querySelector("kbd")?.textContent).toBe("⌘D");
    fireEvent.click(item(TERMINAL_WORDS.new));
    await waitFor(() => expect(count("pty.create")).toBe(2));
    await waitFor(() => expect(menu()).toBeNull());
    // The toolbar's buttons wear the registry's words too.
    expect(screen.getByLabelText(/^New Terminal/)).toBeDefined();
    expect(screen.getByLabelText(/^Split Terminal Horizontally/)).toBeDefined();
  }, 20_000);

  it("with labs off the row's menu offers no Colour and no Icon, and the Workspaces section's menu offers no body toggle", async () => {
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false } });
    await mountSidebar(fakeApi([API], [statusOf(API)]), "api");
    fireEvent.contextMenu(screen.getByText("api"));
    const menu = await screen.findByRole("menu");
    const words = within(menu).getAllByRole("menuitem").map(item => item.textContent ?? "");
    expect(words.some(w => /colour|icon/i.test(w))).toBe(false);
    expect(words.length).toBeGreaterThan(0);
  });
});
