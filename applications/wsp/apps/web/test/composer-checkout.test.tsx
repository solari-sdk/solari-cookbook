// SPDX-License-Identifier: AGPL-3.0-only
// The checkout row under the composer: before the first message it offers
// the folder and names its branch over the daemon wire, across the same
// roots the panes browse, and the send starts the session in that folder;
// after a turn it is a label carrying the harness's own cwd, which the
// panes follow until pinned. Base UI's menu popup never settles under jsdom
// (its positioner loops and a close hangs the run), so the menu primitives
// are stood in by a plain open/closed context here and the picker's own
// browsing and picking run for real.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, createContext, useContext, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REPO_STATE_WORDS, type EventUnion, type SessionEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { FOLDER_GHOST_WITH_WALK } from "../src/files/FolderPathField.js";

vi.mock("../src/components/ui/menu.js", () => {
  const Ctx = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Menu = ({ children, open, onOpenChange }: { children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => {
    const [own, setOwn] = useState(false);
    const set = (next: boolean) => {
      setOwn(next);
      onOpenChange?.(next);
    };
    return <Ctx.Provider value={{ open: open ?? own, set }}>{children}</Ctx.Provider>;
  };
  // Base UI renders the element the trigger is handed, so the stand-in clones it rather than painting a bare button:
  // the trigger a test reads then carries the same merged classes the app's does, the button's own among them.
  const MenuTrigger = ({ children, render: element, className, ...props }: { children: ReactNode; render?: ReactElement<Record<string, unknown>>; className?: string; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    const own = { className, onClick: () => ctx.set(!ctx.open), ...(props as Record<string, unknown>) };
    return element === undefined ? <button type="button" {...own}>{children}</button> : cloneElement(element, own, children);
  };
  // Base UI dismisses the popup on an Escape that reaches it, which is the whole of what a field inside one must
  // not swallow, so the stand-in does the same.
  const MenuPopup = ({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) => {
    const ctx = useContext(Ctx);
    return ctx.open ? (
      <div role="menu" className={className} style={style} onKeyDown={e => (e.key === "Escape" ? ctx.set(false) : undefined)}>
        {children}
      </div>
    ) : null;
  };
  const MenuItem = ({ children, onClick, closeOnClick = true, disabled, ...props }: { children: ReactNode; onClick?: () => void; closeOnClick?: boolean; disabled?: boolean; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    return (
      <div
        role="menuitem"
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled) return;
          onClick?.();
          if (closeOnClick) ctx.set(false);
        }}
        {...(props as Record<string, unknown>)}
      >
        {children}
      </div>
    );
  };
  const MenuGroup = ({ children }: { children: ReactNode }) => <div role="group">{children}</div>;
  // The app's kit closes the menu on a radio pick unless the caller says otherwise; the stand-in does the same.
  const RadioCtx = createContext<{ value: unknown; change: (value: unknown) => void }>({ value: null, change: () => {} });
  const MenuRadioGroup = ({ children, value, onValueChange, ...props }: { children: ReactNode; value?: unknown; onValueChange?: (value: unknown) => void; [key: string]: unknown }) => (
    <div role="group" {...(props as Record<string, unknown>)}>
      <RadioCtx.Provider value={{ value, change: onValueChange ?? (() => {}) }}>{children}</RadioCtx.Provider>
    </div>
  );
  const MenuRadioItem = ({ children, value, closeOnClick = true, ...props }: { children: ReactNode; value: unknown; closeOnClick?: boolean; [key: string]: unknown }) => {
    const radio = useContext(RadioCtx);
    const menu = useContext(Ctx);
    return (
      <div
        role="menuitemradio"
        aria-checked={radio.value === value ? "true" : "false"}
        onClick={() => {
          radio.change(value);
          if (closeOnClick) menu.set(false);
        }}
        {...(props as Record<string, unknown>)}
      >
        {children}
      </div>
    );
  };
  const MenuSeparator = () => <hr />;
  return { Menu, MenuTrigger, MenuPopup, MenuItem, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuSeparator };
});

vi.mock("../src/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) => cloneElement(element, {}, children),
  TooltipPopup: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));

import { BUTTON_GLYPH_INSET } from "../src/components/ui/button.js";
import { installFakeLayout } from "./fake-layout.js";
import { TABLE_CATALOG, whenAgentsAnswered } from "./agents.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useNewThreadRequests } from "../src/components/chat/newThreadRequests.js";
import { selectRoot, useRootStore } from "../src/files/root.js";
import { provideDaemonHello, provideDaemonWire } from "../src/files/wire.js";
import { DAEMON_HELLO, DAEMON_ROOT, fakeWire, imported, LISTING, PROJECT_DEST, resetSurfaces } from "./surface-harness.js";
import { CHAT_STREAM, CHAT_WS } from "./fixtures/chat-stream.js";
import { caps } from "./caps.js";
import { statusOf } from "./workspace-status.js";
import { noDaemonApi } from "./fake-daemon-api.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => {
  resetSurfaces();
  provideDaemonHello(WS, DAEMON_HELLO);
  useComposerDraftStore.setState({ drafts: {} });
});

const WS = CHAT_WS;
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "sess_0001",
};
/** The same workspace after one import: the picker browses home and the project folder. */
const withProject: WorkspaceView = { ...workspace, project: { id: "pr_wsp", name: "wsp", path: PROJECT_DEST, computer: "default" } };
const STATUS = { branch: { oid: "abc", head: "feature/panes", ahead: 0, behind: 0 }, entries: [], root: "/root/app" };

function fixtureApi(history: SessionEvent[] = [], rows: SessionView[] = [], ws: WorkspaceView = workspace) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: Array<{ workspaceId: string; prompt: string; resume?: string; cwd?: string; project?: string }> = [];
  const api: Api = {
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => history,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [ws],
    getWorkspace: async () => ws,
    createWorkspace: async () => ws,
    nap: async () => ws,
    wake: async () => ws,
    capabilities: async () => (caps()),
    listSessions: async () => rows,
    listHarnesses: async () => [TABLE_CATALOG],
    watchStatuses: async () => [],
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 };
    },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, started, emit };
}

async function setup(api: Api, threadId: string | null = null) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {} });
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  await whenAgentsAnswered();
  render(<WorkspaceThread workspaceId={WS} threadId={threadId} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
}

const row = () => document.querySelector<HTMLElement>("[data-composer-checkout]");
const folder = () => document.querySelector<HTMLElement>("[data-composer-folder]")?.dataset["composerFolder"];
const branchSlot = () => document.querySelector<HTMLElement>("[data-composer-branch]");
const branch = () => branchSlot()?.dataset["composerBranch"];
const BRANCH_NOTE = "The folder's branch as the task reports it. Nothing here switches it; check out another branch from the terminal.";
/** The height pair the folder label and the size-xs picker button carry; an empty slot with it keeps the row from moving. */
const SLOT_HEIGHT = ["h-7", "sm:h-6"];
/** The folder's own item in either form: it is the one that gives its width up, and it keeps what it cannot hold inside its box. */
const FOLDER_ITEM = ["min-w-0", "shrink", "overflow-hidden"];
/** The path inside it, cut with an ellipsis at its head. */
const FOLDER_PATH = ["min-w-0", "truncate", "font-mono", "[direction:rtl]"];
const folderItem = () => document.querySelector<HTMLElement>("[data-composer-folder]")!;
const folderPath = () => folderItem().querySelector<HTMLElement>("span")!;
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
const root = () => selectRoot(useRootStore.getState().byWorkspaceId, WS, [DAEMON_ROOT]);
const menuEntry = (path: string) => document.querySelector<HTMLElement>(`[data-composer-folder-entry="${path}"]`);
const menuPick = (path: string) => document.querySelector<HTMLElement>(`[data-composer-folder-pick="${path}"]`);
const menuUp = () => document.querySelector<HTMLElement>("[data-composer-folder-up]");
/** The path inside a row that commits the person to a folder, which is the part that has to read whole at its tail. */
const rowPath = (row: HTMLElement) => row.querySelector<HTMLElement>("[dir=ltr]")!.parentElement!;
const menuPopup = () => document.querySelector<HTMLElement>("[role=menu]")!;
const composerBox = () => document.querySelector<HTMLElement>("[data-chat-composer]")!;
const menuRoots = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-composer-folder-root]")).map(el => [el.dataset["composerFolderRoot"], el.getAttribute("aria-checked")]);
const pathField = () => document.querySelector<HTMLInputElement>('[data-k="folder-path"]');
const refusalSlot = () => document.querySelector<HTMLElement>('[data-k="folder-path-refusal"]');
const chooseRow = () => document.querySelector<HTMLElement>("[data-composer-folder-choose]");
/** What the workspace's machine says it is, which is half of the rule that hides a home's own Library. */
const onAMac = (mac: boolean) => {
  const workspaceView = useStore.getState().workspaces[0]!;
  act(() => useStore.setState({ statuses: { [WS]: statusOf(workspaceView, { facts: { os: mac ? "macOS 15.5" : "Ubuntu 24.04.1 LTS", uptimeMs: 1_000, folder: "/" } }) } }));
};

const openPicker = async (at: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Working folder: ${at}` }));
  await waitFor(() => expect(pathField()).not.toBeNull());
};
const typePath = (path: string) => {
  const field = pathField()!;
  fireEvent.change(field, { target: { value: path } });
  fireEvent.keyDown(field, { key: "Enter" });
};

describe("composer checkout row", () => {
  it("offers the folder before the first message, names its branch, and starts the session there", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) });
    provideDaemonWire(WS, wire);
    const { api, started } = fixtureApi();
    await setup(api);
    expect(row()?.dataset["pickable"]).toBe("true");
    expect(folder()).toBe("/root");
    await waitFor(() => expect(branch()).toBe("feature/panes"));

    // The picker browses the daemon's listings from the daemon root down; the pick is the folder's absolute path.
    fireEvent.click(screen.getByRole("button", { name: "Working folder: /root" }));
    await waitFor(() => expect(menuEntry("/root/app")).not.toBeNull());
    expect(menuPick("/root")).not.toBeNull();
    expect(menuUp()).toBeNull();
    expect(menuRoots()).toEqual([]);
    fireEvent.click(menuEntry("/root/app")!);
    await waitFor(() => expect(menuEntry("/root/app/lib")).not.toBeNull());
    expect(wire.calls.filter(([op]) => op === "fs.list").map(([, p]) => p["path"])).toEqual(["/root", "/root/app"]);
    fireEvent.click(menuPick("/root/app")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Working folder: /root/app" })).toBeTruthy());
    expect(wire.calls.filter(([op]) => op === "git.status").map(([, p]) => p["cwd"])).toEqual(["/root", "/root/app"]);
    expect(root()).toBe("/root/app");

    const editor = composerEditor();
    await typeInto(editor, "build it here");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "build it here", cwd: "/root/app" });
  });

  it("names a repository's branch with the glyph beside it and says on hover that it is read, not switched", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api } = fixtureApi();
    await setup(api);
    await waitFor(() => expect(branch()).toBe("feature/panes"));
    const slot = branchSlot()!;
    expect(slot.querySelector("svg")).not.toBeNull();
    expect(slot.textContent).toBe("feature/panes");
    expect(screen.getByText(BRANCH_NOTE).getAttribute("role")).toBe("tooltip");
  });

  it("says in the branch slot that the machine could not read the folder's git state, before the first message, and nothing shifts", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": () => Object.assign(new Error("outside the browsable roots"), { code: "outside-root" }) });
    provideDaemonWire(WS, wire);
    const { api } = fixtureApi();
    await setup(api);
    await waitFor(() => expect(branch()).toBe("refused"));
    expect(screen.getByRole("button", { name: "Working folder: /root" })).toBeTruthy();
    const slot = branchSlot()!;
    expect(slot.querySelector("svg")).toBeNull();
    expect(slot.textContent).toBe(REPO_STATE_WORDS.refused.word);
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(SLOT_HEIGHT));
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(["font-mono", "text-muted-foreground"]));
    expect(screen.queryByText(BRANCH_NOTE)).toBeNull();
    expect(screen.getByText(REPO_STATE_WORDS.refused.note).getAttribute("role")).toBe("tooltip");
    expect(folder()).toBe("/root");
  });

  it("says the same word beside the locked label once a turn exists: a dropped wire is a read that failed too", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": () => new Error("socket closed") }));
    const { api } = fixtureApi(CHAT_STREAM.slice());
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    expect(row()?.dataset["pickable"]).toBeUndefined();
    await waitFor(() => expect(branch()).toBe("refused"));
    const slot = branchSlot()!;
    expect(slot.textContent).toBe(REPO_STATE_WORDS.refused.word);
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(SLOT_HEIGHT));
    expect(screen.getByText(REPO_STATE_WORDS.refused.note).getAttribute("role")).toBe("tooltip");
  });

  it("asks again every time the link changes its word, so a read made before it was up is not the row's last word", async () => {
    // The wire is there from the first paint and the link is up a moment later; asked once, the row kept the
    // refusal from that first read for the whole of a session, on a folder it could read fine.
    let up = false;
    const wire = fakeWire({ "fs.list": LISTING, "git.status": () => (up ? STATUS : new Error("daemon unreachable")) });
    provideDaemonWire(WS, wire);
    const terminals = new WorkspaceTerminals(wire);
    provideTerminals(WS, terminals);
    const { api } = fixtureApi(CHAT_STREAM.slice());
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    await waitFor(() => expect(branch()).toBe("refused"));
    up = true;
    act(() => terminals.feedStatus("live"));
    await waitFor(() => expect(branch()).toBe("feature/panes"));
    expect(branchSlot()?.textContent).toBe("feature/panes");
    provideTerminals(WS, null);
  });

  it("draws the path the one way in both forms, inside a box that gives its width up, so a long one never reaches the branch slot", async () => {
    const LONG = "/var/folders/xx/90zsjs6n7yjgw9bb1vp6_tx00000gn/T/checkouts/acme-platform/services/gateway-and-edge-router";
    provideDaemonHello(WS, { ...DAEMON_HELLO, root: LONG });
    const onLong = { ...workspace, project: { id: "pr_1", name: "the-project", path: LONG, computer: "default" } };

    // Before the first message: the picker button.
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    await setup(fixtureApi([], [], onLong).api);
    await waitFor(() => expect(branch()).toBe("feature/panes"));
    expect(folder()).toBe(LONG);
    const picker = { item: folderItem().className.split(" "), path: folderPath().className, text: folderPath().textContent };
    // The button's own no-shrink rule is what grew it over the branch, so that it loses the merge is read first.
    expect(picker.item).not.toContain("shrink-0");
    expect(picker.item).toEqual(expect.arrayContaining(FOLDER_ITEM));
    expect(branchSlot()!.className.split(" ")).toContain("shrink-0");
    cleanup();

    // On a thread that has run: the plain label, carrying that thread's own folder.
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    await setup(fixtureApi(CHAT_STREAM.map(e => (e.type === "session.start" ? { ...e, cwd: LONG } : e))).api);
    await screen.findByText(/Server is live at :3000\./);
    expect(row()?.dataset["pickable"]).toBeUndefined();
    expect(folder()).toBe(LONG);
    const label = { item: folderItem().className.split(" "), path: folderPath().className, text: folderPath().textContent };
    expect(label.item).not.toContain("shrink-0");
    expect(label.item).toEqual(expect.arrayContaining(FOLDER_ITEM));
    expect(branchSlot()!.className.split(" ")).toContain("shrink-0");

    // The glyph inset the picker button brings with it, so the path starts on the same pixel in both forms.
    expect(label.item).toContain(BUTTON_GLYPH_INSET);
    expect(picker.item).toContain(BUTTON_GLYPH_INSET);

    // One rule for the path, written once, and the whole path in the DOM: the cut is the box's, not a shortened string.
    expect(label.path).toBe(picker.path);
    expect(label.path.split(" ")).toEqual(expect.arrayContaining(FOLDER_PATH));
    expect(label.text).toBe(LONG);
    expect(picker.text).toBe(LONG);
  });

  it("leaves the branch slot empty, no glyph and no words, while the ask is still out", async () => {
    const inner = fakeWire({ "fs.list": LISTING });
    const wire: TerminalWire = { request: (op, params) => (op === "git.status" ? new Promise(() => {}) : inner.request(op, params)) };
    provideDaemonWire(WS, wire);
    const { api } = fixtureApi();
    await setup(api);
    await settle();
    const slot = branchSlot()!;
    expect(branch()).toBe("unknown");
    expect(slot.querySelector("svg")).toBeNull();
    expect(slot.textContent).toBe("");
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(SLOT_HEIGHT));
    expect(screen.queryByText(BRANCH_NOTE)).toBeNull();
    expect(screen.queryByText(REPO_STATE_WORDS.refused.note)).toBeNull();
    expect(folder()).toBe("/root");
  });

  it("leaves the branch slot empty for a folder outside any repository", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": () => Object.assign(new Error("not a git repository"), { code: "not-a-git-repo" }) });
    provideDaemonWire(WS, wire);
    const { api } = fixtureApi();
    await setup(api);
    await waitFor(() => expect(branch()).toBe("none"));
    const slot = branchSlot()!;
    expect(slot.querySelector("svg")).toBeNull();
    expect(slot.textContent).toBe("");
    expect(slot.className.split(" ")).toEqual(expect.arrayContaining(SLOT_HEIGHT));
    expect(screen.queryByText("no repository")).toBeNull();
    expect(screen.queryByText(BRANCH_NOTE)).toBeNull();
    expect(screen.queryByText(REPO_STATE_WORDS.refused.note)).toBeNull();
  });

  it("offers home and the imported project as roots, and browses and picks inside the project", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) });
    provideDaemonWire(WS, wire);
    const { api, started } = fixtureApi([], [], withProject);
    await setup(api);
    // A workspace with an imported project opens its threads there, so the picker starts inside it.
    expect(folder()).toBe(PROJECT_DEST);

    fireEvent.click(screen.getByRole("button", { name: `Working folder: ${PROJECT_DEST}` }));
    await waitFor(() => expect(menuEntry(`${PROJECT_DEST}/packages`)).not.toBeNull());
    expect(menuRoots()).toEqual([["/root", "false"], [PROJECT_DEST, "true"]]);
    expect(menuPick(PROJECT_DEST)).not.toBeNull();
    // Up stops at the project root, which the daemon browses; its parent is outside every root.
    expect(menuUp()).toBeNull();

    // Home is still a root the picker offers, and switching back is one click.
    fireEvent.click(document.querySelector<HTMLElement>('[data-composer-folder-root="/root"]')!);
    await waitFor(() => expect(menuEntry("/root/app")).not.toBeNull());
    expect(menuRoots()).toEqual([["/root", "true"], [PROJECT_DEST, "false"]]);
    fireEvent.click(document.querySelector<HTMLElement>(`[data-composer-folder-root="${PROJECT_DEST}"]`)!);
    await waitFor(() => expect(menuEntry(`${PROJECT_DEST}/packages`)).not.toBeNull());

    fireEvent.click(menuEntry(`${PROJECT_DEST}/packages`)!);
    await waitFor(() => expect(menuEntry(`${PROJECT_DEST}/packages/web`)).not.toBeNull());
    expect(menuUp()?.dataset["composerFolderUp"]).toBe(PROJECT_DEST);
    // The listing is kept per folder, so coming back to the project root costs no second fs.list.
    expect(wire.calls.filter(([op]) => op === "fs.list").map(([, p]) => p["path"])).toEqual([PROJECT_DEST, "/root", `${PROJECT_DEST}/packages`]);

    fireEvent.click(menuPick(`${PROJECT_DEST}/packages`)!);
    await waitFor(() => expect(screen.getByRole("button", { name: `Working folder: ${PROJECT_DEST}/packages` })).toBeTruthy());
    const editor = composerEditor();
    await typeInto(editor, "work in the project");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "work in the project", cwd: `${PROJECT_DEST}/packages` });
  });

  it("starts an unpicked thread naming no folder at all: the runtime opens it in the workspace's project, which is the folder under the box", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) }));
    const { api, started } = fixtureApi([], [], withProject);
    await setup(api);
    expect(folder()).toBe(PROJECT_DEST);
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.project).toBeUndefined();
    expect(started[0]?.cwd).toBeUndefined();
  });

  it("on this computer the line names the workspace's own folder, the one the runtime publishes, not the home the daemon browses from, and the start still names nothing", async () => {
    const WORK = "/Users/dev/wsp-work";
    provideDaemonHello(WS, { ...DAEMON_HELLO, root: "/Users/dev" });
    provideDaemonWire(WS, fakeWire({ "fs.list": () => ({ entries: [], truncated: false, total: 0 }), "git.status": () => Object.assign(new Error("not a git repository"), { code: "not-a-git-repo" }) }));
    const { api, started } = fixtureApi([], [], { ...workspace, kind: "local", machineId: "local", project: { id: "pr_1", name: "the-project", path: WORK, computer: "default" }, golden: "", folder: WORK });
    await setup(api);
    expect(folder()).toBe(WORK);
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.cwd).toBeUndefined();
    expect(started[0]?.project).toBeUndefined();
  });

  it("starts an unpicked thread on a workspace without projects naming no folder, so the runtime's rule lands it in the machine's own, the one the line under the box shows", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, started } = fixtureApi();
    await setup(api);
    expect(folder()).toBe("/root");
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.cwd).toBeUndefined();
    expect(started[0]?.project).toBeUndefined();
  });

  it("offers no picker and sends no cwd before the daemon named its root", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    provideDaemonHello(WS, null);
    const { api, started } = fixtureApi();
    await setup(api);
    expect(screen.queryByRole("button", { name: /Working folder/ })).toBeNull();
    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.cwd).toBeUndefined();
  });

  it("is a label after a turn, carries the harness's cwd, and the panes follow it until pinned", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, started, emit } = fixtureApi(CHAT_STREAM.slice());
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    expect(row()?.dataset["pickable"]).toBeUndefined();
    expect(screen.queryByRole("button", { name: /Working folder/ })).toBeNull();
    expect(folder()).toBe("/root");
    expect(root()).toBe("/root");

    const editor = composerEditor();
    await typeInto(editor, "and now from the app");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ resume: workspace.claudeSessionId, cwd: "/root" });

    emit({ type: "session.start", workspaceId: WS, sessionId: "sess_0002", turnId: "turn_0002", at: Date.now(), cwd: "/root/app" });
    await waitFor(() => expect(folder()).toBe("/root/app"));
    expect(root()).toBe("/root/app");

    act(() => useRootStore.getState().pin(WS, "/root/app"));
    emit({ type: "session.start", workspaceId: WS, sessionId: "sess_0003", turnId: "turn_0003", at: Date.now(), cwd: "/root/app/packages/web" });
    await waitFor(() => expect(folder()).toBe("/root/app/packages/web"));
    expect(root()).toBe("/root/app");
  });

  it("follows the agent's shell when a tool call moves it, while the strip keeps the harness folder, until pinned", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, emit } = fixtureApi(CHAT_STREAM.slice());
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    expect(folder()).toBe("/root");
    expect(root()).toBe("/root");

    const scope = { workspaceId: WS, sessionId: "sess_0002", turnId: "turn_0002" };
    emit({ type: "session.start", ...scope, at: Date.now(), cwd: "/root" });
    emit({ type: "session.delta", ...scope, at: Date.now(), kind: "tool_use", toolName: "Bash", toolUseId: "t1", text: JSON.stringify({ command: "cd /root/app && ls" }), cwd: "/root/app" });
    await waitFor(() => expect(root()).toBe("/root/app"));
    expect(folder()).toBe("/root");

    act(() => useRootStore.getState().pin(WS, "/root/app"));
    emit({ type: "session.delta", ...scope, at: Date.now(), kind: "tool_use", toolName: "Bash", toolUseId: "t2", text: JSON.stringify({ command: "cd /root/app/lib" }), cwd: "/root/app/lib" });
    await waitFor(() => expect(useRootStore.getState().byWorkspaceId[WS]?.shell).toBe("/root/app/lib"));
    expect(root()).toBe("/root/app");
    expect(folder()).toBe("/root");
    act(() => useRootStore.getState().unpin(WS));
    expect(root()).toBe("/root/app/lib");

    // The shell folder is the thread's: a new thread starts over from the harness folder.
    act(() => useNewThreadRequests.getState().request(WS));
    await waitFor(() => expect(root()).toBe("/root"));
  });

  it("explains the locked folder on hover and offers no new-thread button beside it", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api } = fixtureApi(CHAT_STREAM.slice());
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    expect(row()?.dataset["pickable"]).toBeUndefined();
    expect(screen.getByText("The folder this thread's harness runs in. A cd inside the agent's shell does not move it; start a new thread to work from another folder.").getAttribute("role")).toBe("tooltip");
    expect(screen.queryByRole("button", { name: "New thread here" })).toBeNull();
  });

  it("walks past the machine's own folders, and the typed path is the road into one on purpose", async () => {
    // A person's own home, as the machine really answers one: two dot-named folders, a Mac's own Library, and the
    // one folder they made.
    const HOME = "/Users/priya";
    const home = {
      entries: [
        { name: ".cache", type: "dir", size: 0, mtime: 1 },
        { name: ".config", type: "dir", size: 0, mtime: 1 },
        { name: "Library", type: "dir", size: 0, mtime: 1 },
        { name: "code", type: "dir", size: 0, mtime: 1 },
        { name: "notes.md", type: "file", size: 12, mtime: 1 },
      ],
      truncated: false,
      total: 5,
    };
    provideDaemonHello(WS, { ...DAEMON_HELLO, root: HOME });
    const wire = fakeWire({
      "fs.list": params => {
        const path = String(params["path"]);
        if (path === HOME) return home;
        if (path === `${HOME}/code` || path === `${HOME}/.config`) return { entries: [], truncated: false, total: 0 };
        throw Object.assign(new Error(`${path} does not exist`), { code: "not-found" });
      },
      "git.status": STATUS,
    });
    provideDaemonWire(WS, wire);
    const { api } = fixtureApi([], [], { ...workspace, project: { id: "pr_1", name: "the-project", path: HOME, computer: "default" } });
    await setup(api);
    // The machine says what it is; the Library is hidden because this home is its own, not because of the path.
    onAMac(true);
    await openPicker(HOME);
    await waitFor(() => expect(menuEntry(`${HOME}/code`)).not.toBeNull());
    expect(menuEntry(`${HOME}/.cache`)).toBeNull();
    expect(menuEntry(`${HOME}/.config`)).toBeNull();
    expect(menuEntry(`${HOME}/Library`)).toBeNull();
    expect(Array.from(document.querySelectorAll("[data-composer-folder-entry]")).map(el => el.textContent)).toEqual(["code"]);

    // Hidden from the walk, not out of reach: the path typed whole opens one.
    typePath(`${HOME}/.config`);
    await waitFor(() => expect(screen.getByRole("button", { name: `Working folder: ${HOME}/.config` })).toBeTruthy());
    expect(root()).toBe(`${HOME}/.config`);
  });

  it("keeps a Library that is not a Mac home's own, since only a Mac keeps one there", async () => {
    const HOME = "/home/dev";
    const home = {
      entries: [
        { name: ".config", type: "dir", size: 0, mtime: 1 },
        { name: "Library", type: "dir", size: 0, mtime: 1 },
        { name: "code", type: "dir", size: 0, mtime: 1 },
      ],
      truncated: false,
      total: 3,
    };
    provideDaemonHello(WS, { ...DAEMON_HELLO, root: HOME });
    provideDaemonWire(
      WS,
      fakeWire({
        "fs.list": params => (String(params["path"]) === HOME ? home : { entries: [], truncated: false, total: 0 }),
        "git.status": STATUS,
      }),
    );
    const { api } = fixtureApi([], [], { ...workspace, project: { id: "pr_1", name: "the-project", path: HOME, computer: "default" } });
    await setup(api);
    onAMac(false);
    await openPicker(HOME);
    await waitFor(() => expect(menuEntry(`${HOME}/code`)).not.toBeNull());
    // The dot folder is the machine's own wherever it runs; the Library on this one is a folder somebody made.
    expect(menuEntry(`${HOME}/.config`)).toBeNull();
    expect(menuEntry(`${HOME}/Library`)).not.toBeNull();
  });

  it("picks a folder pasted into the field on Enter, whatever level the walk is on, and starts the session there", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) });
    provideDaemonWire(WS, wire);
    const { api, started } = fixtureApi();
    await setup(api);
    await openPicker("/root");
    expect(refusalSlot()!.textContent).toBe("");

    typePath("  /root/app/lib  ");
    await waitFor(() => expect(screen.getByRole("button", { name: "Working folder: /root/app/lib" })).toBeTruthy());
    // The pick closes the picker, as a pick from a row does.
    expect(pathField()).toBeNull();
    expect(root()).toBe("/root/app/lib");
    expect(wire.calls.filter(([op]) => op === "fs.list").map(([, p]) => p["path"])).toEqual(["/root", "/root/app/lib"]);

    const editor = composerEditor();
    await typeInto(editor, "work where I pasted");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "work where I pasted", cwd: "/root/app/lib" });
  });

  it("refuses a folder the workspace has not, in the two halves under the field, and moves nothing else", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": params => ({ ...STATUS, root: String(params["cwd"]) }) });
    provideDaemonWire(WS, wire);
    const { api, started } = fixtureApi();
    await setup(api);
    await openPicker("/root");
    // The slot stands at its two lines before anything is refused, so a refusal arriving moves nothing under it.
    expect(refusalSlot()!.textContent).toBe("");
    expect(refusalSlot()!.className.split(" ")).toEqual(expect.arrayContaining(["min-h-9", "font-mono", "text-xs", "text-destructive-foreground"]));
    expect(pathField()!.getAttribute("aria-invalid")).toBeNull();
    expect(document.querySelector("[data-refused]")).toBeNull();

    typePath("/root/nope");
    await waitFor(() => expect(refusalSlot()!.textContent).toBe("No folder there. Check the path, or walk to it below."));
    expect(refusalSlot()!.querySelector("span")!.className).toContain("text-foreground");
    expect(pathField()!.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector("[data-refused]")).not.toBeNull();
    expect(pathField()!.value).toBe("/root/nope");
    // The picker is still up on the level it was on, the row still names the folder it named, and the panes did not move.
    expect(menuPick("/root")).not.toBeNull();
    expect(menuEntry("/root/app")).not.toBeNull();
    expect(folder()).toBe("/root");
    expect(root()).toBe("/root");

    const editor = composerEditor();
    await typeInto(editor, "hello");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.cwd).toBeUndefined();
  });

  it("refuses a path that is not a full one without asking the workspace, and the next edit clears the refusal", async () => {
    const wire = fakeWire({ "fs.list": LISTING, "git.status": STATUS });
    provideDaemonWire(WS, wire);
    await setup(fixtureApi().api);
    await openPicker("/root");

    typePath("code/spoo");
    await waitFor(() => expect(refusalSlot()!.textContent).toBe("That is not a full path. Start it with a slash."));
    expect(wire.calls.filter(([op]) => op === "fs.list").map(([, p]) => p["path"])).toEqual(["/root"]);

    fireEvent.change(pathField()!, { target: { value: "/root/app" } });
    await waitFor(() => expect(refusalSlot()!.textContent).toBe(""));
    expect(pathField()!.getAttribute("aria-invalid")).toBeNull();
  });

  it("keeps a slow read's refusal off a path typed after it", async () => {
    let refuse: (() => void) | undefined;
    const inner = fakeWire({ "fs.list": LISTING, "git.status": STATUS });
    const wire: TerminalWire = {
      request: (op, params = {}) =>
        op === "fs.list" && params["path"] === "/root/slow"
          ? new Promise((_ok, no) => {
              refuse = () => no(Object.assign(new Error("/root/slow does not exist"), { code: "not-found" }));
            })
          : inner.request(op, params),
    };
    provideDaemonWire(WS, wire);
    await setup(fixtureApi().api);
    await openPicker("/root");

    typePath("/root/slow");
    fireEvent.change(pathField()!, { target: { value: "/root/app" } });
    await act(async () => {
      refuse!();
      await Promise.resolve();
    });
    expect(refusalSlot()!.textContent).toBe("");
    expect(pathField()!.value).toBe("/root/app");
  });

  it("wears the card field's own size and ghosts a hint, never a path a person could type back", async () => {
    provideDaemonHello(WS, { ...DAEMON_HELLO, root: "/root" });
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    await setup(fixtureApi().api);
    await openPicker("/root");
    // A ghost shaped like a path reads as the app naming a folder that is there; the one that stood here was typed
    // back and refused. It names the two roads instead and carries no path at all.
    expect(pathField()!.placeholder).toBe(FOLDER_GHOST_WITH_WALK);
    expect(pathField()!.placeholder).not.toContain("/");
    // The shipped compact size, so the typed path reads at the refusal's 12 px rather than the primitive's 14.
    expect(pathField()!.className.split(" ")).toEqual(expect.arrayContaining(["text-xs"]));
    expect(pathField()!.closest("[data-slot=input-control]")!.getAttribute("data-size")).toBe("compact");
  });

  it("shows which folder each committing row is about, cut at its head, in a menu that grows to the rows", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    await setup(fixtureApi().api);
    await openPicker("/root");
    fireEvent.click(menuEntry("/root/app")!);
    await waitFor(() => expect(menuUp()).not.toBeNull());

    // Both rows name their folder whole, in the row's own slot; under a deep home the tail is what tells two
    // folders apart, so the path is cut at its head exactly as the button above the box cuts it.
    const pick = rowPath(menuPick("/root/app")!);
    const up = rowPath(menuUp()!);
    expect(pick.textContent).toBe("/root/app");
    expect(up.textContent).toBe("/root");
    for (const path of [pick, up]) expect(path.className.split(" ")).toEqual(expect.arrayContaining(FOLDER_PATH));

    // The menu is no longer held at one width: it asks for what its rows need and grows to them up to the width of
    // the composer it belongs to, which is where the ticket puts its ceiling. The fake layout gives every box 800 px,
    // so that is what the composer measures here.
    expect(menuPopup().style.maxWidth).toBe(`${composerBox().getBoundingClientRect().width}px`);
    expect(menuPopup().className.split(" ")).toEqual(["min-w-72"]);
  });

  it("opens the picker again empty: a refusal from last time is not still standing", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    await setup(fixtureApi().api);
    await openPicker("/root");
    typePath("/root/nope");
    await waitFor(() => expect(refusalSlot()!.textContent).toBe("No folder there. Check the path, or walk to it below."));

    fireEvent.click(screen.getByRole("button", { name: "Working folder: /root" }));
    await waitFor(() => expect(pathField()).toBeNull());
    await openPicker("/root");
    expect(pathField()!.value).toBe("");
    expect(refusalSlot()!.textContent).toBe("");
    expect(pathField()!.getAttribute("aria-invalid")).toBeNull();
  });

  it("closes on Escape typed in the field, the one key the field does not keep to itself", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    await setup(fixtureApi().api);
    await openPicker("/root");

    fireEvent.change(pathField()!, { target: { value: "/root/app" } });
    fireEvent.keyDown(pathField()!, { key: "Escape" });
    await waitFor(() => expect(pathField()).toBeNull());
    expect(menuPick("/root")).toBeNull();
    expect(folder()).toBe("/root");
  });

  it("offers the system chooser only where the shell has one, and lands its folder as a pick", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    await setup(fixtureApi().api);
    await openPicker("/root");
    expect(chooseRow()).toBeNull();
    cleanup();

    const pickFolder = vi.fn(async () => "/root/app");
    (window as { wsp?: unknown }).wsp = { pickFolder };
    try {
      resetSurfaces();
      provideDaemonHello(WS, DAEMON_HELLO);
      provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
      const { api, started } = fixtureApi();
      await setup(api);
      await openPicker("/root");
      expect(chooseRow()!.textContent).toContain("Choose a folder");

      fireEvent.click(chooseRow()!);
      await waitFor(() => expect(screen.getByRole("button", { name: "Working folder: /root/app" })).toBeTruthy());
      expect(pickFolder).toHaveBeenCalledTimes(1);
      expect(root()).toBe("/root/app");

      const editor = composerEditor();
      await typeInto(editor, "work in the chosen folder");
      await press(editor, "Enter");
      await waitFor(() => expect(started).toHaveLength(1));
      expect(started[0]).toMatchObject({ cwd: "/root/app" });
    } finally {
      delete (window as { wsp?: unknown }).wsp;
    }
  });
});

describe("composer checkout row on a thread resumed from its row", () => {
  const TAIL: SessionEvent[] = CHAT_STREAM.slice(1).map(e => ({ ...e, threadId: "thr_a" }));
  const ROW: SessionView = { id: "sess_0001", workspaceId: WS, harness: "claude", status: "completed", claudeSessionId: "sess_0001", threadId: "thr_a", prompt: "hello", startedAt: 0, cwd: "/root/app" };

  it("pinned to a thread whose start fell off the cap, is a label for the row's folder and sends there, not where the person was following", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, started } = fixtureApi(TAIL, [ROW]);
    act(() => useRootStore.getState().follow(WS, "/root/lib"));
    await setup(api, "thr_a");
    await screen.findByText(/Server is live at :3000\./);
    await waitFor(() => expect(folder()).toBe("/root/app"));
    expect(row()?.dataset["pickable"]).toBeUndefined();
    expect(root()).toBe("/root/app");

    const editor = composerEditor();
    await typeInto(editor, "more");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ resume: "sess_0001", cwd: "/root/app" });
  });

  it("on an empty latest view, the remembered session resumes in its row's folder, the strip locked to it, not in the daemon root", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api, started } = fixtureApi([], [ROW]);
    await setup(api);
    await waitFor(() => expect(folder()).toBe("/root/app"));
    expect(row()?.dataset["pickable"]).toBeUndefined();
    expect(screen.queryByRole("button", { name: /Working folder/ })).toBeNull();
    expect(root()).toBe("/root/app");

    const editor = composerEditor();
    await typeInto(editor, "more");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ resume: "sess_0001", cwd: "/root/app" });
  });

  it("an empty latest view whose remembered session has no row keeps the picker: nothing names its folder", async () => {
    provideDaemonWire(WS, fakeWire({ "fs.list": LISTING, "git.status": STATUS }));
    const { api } = fixtureApi([], []);
    await setup(api);
    expect(row()?.dataset["pickable"]).toBe("true");
    expect(folder()).toBe("/root");
  });
});
