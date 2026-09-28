// SPDX-License-Identifier: AGPL-3.0-only
// The composer on its own: keys, the slash menu over the harness catalog, the
// disabled reasons, and the draft that outlives a tab switch. Same fixture api
// shape as chat.test.tsx; no live daemon.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOST_ASLEEP_SEND, composerHeldLine, screenCommandLine, SEND_BLOCK_WORDS, sendRefusal, stillWorkingLine, type EventUnion, type HarnessCatalog, type SessionEvent, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { composerEditor, isEditable, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ConnStatus, ProtocolEvent, StartSessionOptions } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { composerSendBlock } from "../src/components/chat/ChatComposer.js";
import { SEND_LABEL, WAKE_AND_SEND_LABEL } from "../src/components/chat/ComposerPrimaryActions.js";
import { COMPOSER_STATE_WORDS } from "../src/composer-state-words.js";
import { NOT_READY_NAMES } from "../screenshots/ready.mjs";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { requestComposerFocus, requestNewThread } from "../src/shell/shellRequests.js";
import { CHAT_HARNESS, CHAT_STREAM, CHAT_TURN, CHAT_WS } from "./fixtures/chat-stream.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { lastNotice } from "./notice-text.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => useComposerDraftStore.setState({ drafts: {}, queues: {} }));

const WS = CHAT_WS;
const scope = { workspaceId: WS, sessionId: "sess_0001", turnId: CHAT_TURN };
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "e16ed170-8257-4668-879e-fe836341633c",
};

/** The runtime's row for the composer's harness, as the table serves it before a machine answers: the commands that
 * work only in the CLI's own terminal ride it, so the menu and the send read them before any session ran. */
const SCREEN_COMMANDS = [
  { name: "login", control: "sign-in" as const },
  { name: "logout", control: "sign-in" as const },
  { name: "model", control: "model" as const },
  { name: "permissions", control: "access" as const },
  { name: "config", control: "settings" as const },
  { name: "help", control: "docs" as const },
];
const CLAUDE_CATALOG: HarnessCatalog = { harness: "claude", label: "Claude Code", source: "table", version: null, models: [], efforts: [], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false, screenCommands: SCREEN_COMMANDS };

function fixtureApi(workspaces: WorkspaceView[], history: Record<string, SessionEvent[]> = {}, statuses: WorkspaceStatus[] = []) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: StartSessionOptions[] = [];
  const interrupted: string[] = [];
  const api: Api = {
    interruptSession: async id => { interrupted.push(id); return "accepted"; },
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async id => history[id] ?? [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => (caps()),
    listSessions: async () => [],
    listHarnesses: async () => [CLAUDE_CATALOG],
    watchStatuses: async () => statuses,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 };
    },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, started, interrupted, emit };
}

/** The store as a fresh window opens it, then the api bound and the socket put where the case wants it. The
 * catalogs are waited for unless the case is about a composer that has none: a send reads its model and its access
 * out of them, so a composer without them is held and a test that did not wait would be testing that hold. */
async function setup(api: Api, conn: ConnStatus = "live", agents = true) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, harnesses: [], harnessesByWorkspace: {}, launches: {} });
  useStore.getState().bind(api);
  useStore.getState().setConn(conn);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  if (agents) await waitFor(() => expect(useStore.getState().harnesses.length).toBeGreaterThan(0));
  const view = render(<WorkspaceThread workspaceId={WS} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const draft = () => useComposerDraftStore.getState().drafts[WS]?.prompt ?? "";
const sendButton = () => screen.getByRole("button", { name: /Send message|Wake and send|Turn in flight|wsp|Workspace|Loading|Connecting/ }) as HTMLButtonElement;
const menuItem = (name: string) => document.querySelector<HTMLElement>(`[data-composer-item-id="provider-slash-command:claude:${name}"]`);
const menuDrawer = () => document.querySelector<HTMLElement>("[data-composer-command-drawer]");

describe("composer keys", () => {
  it("shift+enter inserts a newline instead of sending", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "line one");
    await press(editor, "Enter", { shiftKey: true });
    await waitFor(() => expect(draft()).toBe("line one\n"));
    expect(started.length).toBe(0);
    await typeInto(editor, "line two");
    expect(draft()).toBe("line one\nline two");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]?.prompt).toBe("line one\nline two");
  });

  it("takes the caret when a workspace switch asks for it, and leaves it alone when another workspace is asked for", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).not.toBe(editor);
    act(() => requestComposerFocus("ws_chat9999"));
    expect(document.activeElement).not.toBe(editor);
    act(() => requestComposerFocus(WS));
    await waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it("takes a caret asked for before it mounted", async () => {
    const { api } = fixtureApi([workspace]);
    requestComposerFocus(WS);
    await setup(api);
    await waitFor(() => expect(document.activeElement).toBe(composerEditor()));
  });

  it("escape with no menu leaves the draft", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "never mind");
    expect(draft()).toBe("never mind");
    await press(editor, "Escape");
    expect(editor.textContent).toBe("never mind");
    expect(draft()).toBe("never mind");
    expect(started.length).toBe(0);
  });

  it("keeps the draft across a tab switch", async () => {
    const { api } = fixtureApi([workspace]);
    const view = await setup(api);
    await typeInto(composerEditor(), "half a thought");
    view.unmount();
    render(<WorkspaceThread workspaceId={WS} />);
    await waitFor(() => expect(composerEditor().textContent).toBe("half a thought"));
  });

  it("does not let undo pull another workspace's draft across a switch", async () => {
    const other: WorkspaceView = { ...workspace, id: "ws_chat0002", name: "web", claudeSessionId: undefined };
    const { api } = fixtureApi([workspace, other]);
    const view = await setup(api);
    await typeInto(composerEditor(), "alpha draft");
    view.rerender(<WorkspaceThread workspaceId={other.id} />);
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    const editor = composerEditor();
    expect(editor.textContent).toBe("");
    editor.focus();
    await press(editor, "z", { ctrlKey: true });
    await press(editor, "z", { metaKey: true });
    expect(editor.textContent).toBe("");
    expect(useComposerDraftStore.getState().drafts[other.id]?.prompt ?? "").toBe("");
    expect(draft()).toBe("alpha draft");
  });

  it("sends nothing on the Enter that commits an IME composition", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "日本");
    fireEvent.compositionStart(editor);
    await press(editor, "Enter", { isComposing: true });
    expect(started.length).toBe(0);
    expect(draft()).toBe("日本");
    fireEvent.compositionEnd(editor);
    // Some engines deliver the committing Enter after compositionend with the legacy 229 code and no flag.
    await press(editor, "Enter", { keyCode: 229 });
    expect(started.length).toBe(0);
    expect(draft()).toBe("日本");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]?.prompt).toBe("日本");
  });
});

/** The session's announcement with the CLI's screen-only commands in it, as a real init lists them beside the ones that run. */
const SCREEN_NAMES = SCREEN_COMMANDS.map(c => c.name);
const ANNOUNCED = [...CHAT_HARNESS.slashCommands, ...SCREEN_NAMES, "my-skill"];
const STREAM_WITH_SCREENS: SessionEvent[] = CHAT_STREAM.map(e => (e.type === "session.start" ? { ...e, harness: { ...CHAT_HARNESS, slashCommands: ANNOUNCED } } : e));
const listed = () => [...document.querySelectorAll("[data-composer-item-id]")].map(el => el.getAttribute("data-composer-item-id")?.split(":").pop());
/** The menu's headings and its rows in the order they are drawn; a command's own name may hold a colon, so the id is
 * read past the two fields in front of it rather than split to the last one. */
const groupLabels = () => [...document.querySelectorAll("[data-composer-command-drawer] [data-slot=command-group-label]")].map(el => el.textContent);
const namesInMenu = () => [...document.querySelectorAll("[data-composer-item-id]")].map(el => (el.getAttribute("data-composer-item-id") ?? "").split(":").slice(2).join(":"));

describe("composer slash menu", () => {
  it("promises no commands before a session announced any", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    expect(composerEditor().getAttribute("aria-placeholder")).toBe("Ask anything");
  });

  it("opens no menu for a slash typed before a session announced any, so nothing answers with an empty state", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(draft()).toBe("/"));
    expect(menuDrawer()).toBeNull();
  });

  it("names the menu in the placeholder once a session announced commands, and a slash opens it on them", async () => {
    const { api } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    expect(editor.getAttribute("aria-placeholder")).toBe("Ask anything, or / for commands");
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
  });

  it("takes the announcement as it lands, with no reload", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    expect(composerEditor().getAttribute("aria-placeholder")).toBe("Ask anything");
    emit({ type: "session.start", ...scope, prompt: "hi", harness: CHAT_HARNESS });
    await waitFor(() => expect(composerEditor().getAttribute("aria-placeholder")).toBe("Ask anything, or / for commands"));
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
  });

  it("offers what the session announced less the commands that work only in the CLI's own terminal, and every custom one", async () => {
    const { api } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
    expect(listed()).toEqual([...CHAT_HARNESS.slashCommands, "my-skill"]);
    for (const name of SCREEN_NAMES) expect(menuItem(name), name).toBeNull();
    // Searching for one finds nothing rather than the screen command, and nothing is drawn: the slot says the name
    // reached nothing, so a drawer under it would say the same in other words.
    await typeInto(editor, "log");
    await waitFor(() => expect(listed()).toEqual([]));
    expect(menuDrawer()).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("no command here is called /log");
  });

  it("lists the commands the session announced, filters as you type, arrows move the highlight, tab picks", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
    for (const name of ["context", "cost", "init", "review"]) expect(menuItem(name)).not.toBeNull();
    expect(menuItem("model")).toBeNull();

    // The shortest prefix match ranks first, so "co" puts cost ahead of compact and context.
    await typeInto(editor, "co");
    await waitFor(() => expect(menuItem("init")).toBeNull());
    expect(listed()).toEqual(["cost", "compact", "context"]);
    expect(menuItem("cost")?.className).toContain("bg-accent!");
    await press(editor, "ArrowDown");
    await waitFor(() => expect(menuItem("compact")?.className).toContain("bg-accent!"));
    expect(menuItem("cost")?.className).not.toContain("bg-accent!");
    await press(editor, "Tab");
    await waitFor(() => expect(draft()).toBe("/compact "));
    expect(listed()).toEqual([]);
    expect(started.length).toBe(0);
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]?.prompt).toBe("/compact");
  });

  it("typing a screen command and Enter sends nothing: the draft stays and the line names wsp's own road for it", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/login");
    await press(editor, "Enter");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeNull());
    expectPlainLine(screenCommandLine(SCREEN_COMMANDS[0]!, CLAUDE_CATALOG, workspace));
    expect(screen.getByRole("status").textContent).toContain("Workspace panel");
    expect(started).toHaveLength(0);
    expect(draft()).toBe("/login");
    expect(isEditable(editor)).toBe(true);
    // The pickers' commands name the row under the box; a command with words after it is still the command.
    await typeInto(editor, " opus");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(draft()).toBe("/login opus");
    await press(editor, "Enter");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeNull());
    expect(started).toHaveLength(0);
  });

  it("a block on the send outranks the screen command's line, and the line is back once the block lifts", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/login");
    await press(editor, "Enter");
    const line = screenCommandLine(SCREEN_COMMANDS[0]!, CLAUDE_CATALOG, workspace);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(line));
    // The socket drops with the draft still in the box: the box is disabled and the slot says so, not the command.
    act(() => useStore.getState().setConn("reconnecting"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(sendRefusal("reconnecting")));
    expect(isEditable(editor)).toBe(false);
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(isEditable(editor)).toBe(true));
    // The draft still reads /login, so the line that explains it is still true.
    expect(screen.getByRole("status").textContent).toBe(line);
    expect(draft()).toBe("/login");
    expect(started).toHaveLength(0);
  });

  it("the line for a sign-in command on this computer names the person's own terminal, not the Workspace panel", async () => {
    const local: WorkspaceView = { ...workspace, kind: "local" };
    const { api, started } = fixtureApi([local]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "/logout");
    await press(editor, "Enter");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeNull());
    expectPlainLine(screenCommandLine(SCREEN_COMMANDS[1]!, CLAUDE_CATALOG, local));
    expect(screen.getByRole("status").textContent).toContain("this computer");
    expect(started).toHaveLength(0);
  });

  it("a slash command the agent never announced still goes as text, since the words may be meant", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/frobnicate now");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("/frobnicate now");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays closed for a slash after the prompt start", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "see /");
    await waitFor(() => expect(draft()).toBe("see /"));
    expect(menuDrawer()).toBeNull();
    // A slash opening a later line is a line the CLI reads as text, so no menu there either.
    await press(editor, "Enter", { shiftKey: true });
    await typeInto(editor, "/");
    await waitFor(() => expect(draft()).toBe("see /\n/"));
    expect(menuDrawer()).toBeNull();
  });

  it("groups what the session announced by the source the name itself gave, in the order announced, and filters inside the groups", async () => {
    // A real init names a plugin's command <plugin>:<command> and announces everything else bare.
    const announced = ["compact", "context", "code-review:code-review", "ralph-loop:help", "my-skill", "code-review:apply"];
    const stream: SessionEvent[] = CHAT_STREAM.map(e => (e.type === "session.start" ? { ...e, harness: { ...CHAT_HARNESS, slashCommands: announced } } : e));
    const { api } = fixtureApi([workspace], { [WS]: stream });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuDrawer()).not.toBeNull());
    expect(groupLabels()).toEqual(["Commands", "code-review", "ralph-loop"]);
    // Each group in the order its source was first named, each command in the order the announcement gave it.
    expect(namesInMenu()).toEqual(["compact", "context", "my-skill", "code-review:code-review", "code-review:apply", "ralph-loop:help"]);
    // The keyboard walks the menu as it is drawn: the first row of the first group is the one that is highlighted.
    expect(menuItem("compact")?.className).toContain("bg-accent!");

    // Typing keeps the headings of whatever still matches and drops the rest. Inside a group the ranking decides,
    // as it did before there were groups; the announcement's order is what an unfiltered menu is drawn in.
    await typeInto(editor, "review");
    await waitFor(() => expect(menuItem("compact")).toBeNull());
    expect(groupLabels()).toEqual(["code-review"]);
    expect(namesInMenu()).toEqual(["code-review:apply", "code-review:code-review"]);
  });

  it("holds a lone slash instead of sending it: the slot says why, the send button is held and wears the same words", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuDrawer()).not.toBeNull());
    const line = "a slash on its own is not a command";
    expect(screen.getByRole("status").textContent).toBe(line);
    const button = screen.getByRole("button", { name: line }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The menu dismissed, the slot holds the same line in the composer's own grammar and nothing else is drawn.
    await press(editor, "Escape");
    await waitFor(() => expect(menuDrawer()).toBeNull());
    expectPlainLine(line);
    await press(editor, "Enter");
    await act(async () => { fireEvent.click(button); });
    expect(started).toHaveLength(0);
    expect(draft()).toBe("/");
    expect(isEditable(editor)).toBe(true);
  });

  it("holds a slash and a name nothing announced, and lets the same name go once words follow it", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/heapdump");
    const line = "no command here is called /heapdump";
    await waitFor(() => expect(screen.queryByRole("status")?.textContent).toBe(line));
    expectPlainLine(line);
    expect((screen.getByRole("button", { name: line }) as HTMLButtonElement).disabled).toBe(true);
    await press(editor, "Enter");
    expect(started).toHaveLength(0);
    expect(draft()).toBe("/heapdump");
    // Words after the name are words that may be meant, so the hold lifts and Enter sends them.
    await typeInto(editor, " of the daemon");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("/heapdump of the daemon");
  });

  it("sends a slash and a name the session did announce", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/compact");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
    await press(editor, "Escape");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("/compact");
  });

  it("escape dismisses the menu, keeps the draft, and the menu returns when the query changes", async () => {
    const { api } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
    await press(editor, "Escape");
    await waitFor(() => expect(menuDrawer()).toBeNull());
    expect(draft()).toBe("/");
    await typeInto(editor, "c");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
  });
});

/** The reserved slot above the composer's box: laid out at one height whether or not a line is in it. */
const slot = () => document.querySelector<HTMLElement>("[data-composer-refusal]");
/** The refusal is one muted mono line in the slot: no panel, no border, no fill, no icon, no caution colour. */
function expectPlainLine(words: string): void {
  const line = screen.getByRole("status");
  expect(line.textContent).toBe(words);
  expect(slot()?.contains(line)).toBe(true);
  expect(line.className).toContain("font-mono");
  expect(line.className).toContain("text-muted-foreground");
  expect(line.className).not.toMatch(/border|bg-|warning|destructive|error/);
  expect(line.querySelector("svg")).toBeNull();
  expect(document.querySelector("[data-composer-banner-surface]")).toBeNull();
}

describe("composer while the workspace is not live", () => {
  it("a paused workspace takes words: no line above the box, the placeholder as always, and the send button reads Wake and send", async () => {
    const { api } = fixtureApi([{ ...workspace, phase: "napping" }]);
    await setup(api);
    expect(isEditable(composerEditor())).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(slot()!.textContent).toBe("");
    expect(composerEditor().closest("[data-chat-composer]")!.textContent).not.toContain("paused");
    expect(sendButton().getAttribute("aria-label")).toBe(WAKE_AND_SEND_LABEL);
    expect(sendButton().getAttribute("title")).toBe(WAKE_AND_SEND_LABEL);
    // Empty, so nothing to send yet; the words make it live, as on a running workspace.
    expect(sendButton().disabled).toBe(true);
    await typeInto(composerEditor(), "hello");
    expect(sendButton().disabled).toBe(false);
  });

  it("says it is connecting in the same words the harness that drives this app waits on", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api, "connecting");
    // One file holds the word. The button renders it, and the harness that drives the built app reads it to know
    // the app is not ready for a key press yet; a second spelling in either place puts a driven step back on a
    // page that is still loading, with nothing said about it.
    expect(sendButton().getAttribute("aria-label")).toBe(SEND_BLOCK_WORDS.connecting);
    expect(NOT_READY_NAMES).toContain(SEND_BLOCK_WORDS.connecting);
    // The composer's own states are the other half of that list, and the two names it exports come from the same
    // file, so every word the button can wear has exactly one home.
    expect(NOT_READY_NAMES).toContain(COMPOSER_STATE_WORDS.connecting);
    expect([SEND_LABEL, WAKE_AND_SEND_LABEL]).toEqual([COMPOSER_STATE_WORDS.send, COMPOSER_STATE_WORDS.wakeAndSend]);
  });

  it("a running workspace's button reads plain Send", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    expect(sendButton().getAttribute("aria-label")).toBe(SEND_LABEL);
    expect(sendButton().getAttribute("title")).toBeNull();
  });

  it("a paused workspace woken by something else keeps the words in the box until the person sends them", async () => {
    const { api, emit, started } = fixtureApi([{ ...workspace, phase: "napping" }]);
    await setup(api);
    await waitFor(() => expect(sendButton().getAttribute("aria-label")).toBe(WAKE_AND_SEND_LABEL));
    await typeInto(composerEditor(), "run the tests");
    // The machine comes up on its own, woken from the command line or another window. The words are still the
    // person's: the box holds a draft, never a queued row, so nothing here has a send to make.
    emit({ type: "workspace.status", status: { ...workspace, phase: "running", machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 } });
    await waitFor(() => expect(sendButton().getAttribute("aria-label")).toBe(SEND_LABEL));
    // A send that can be pressed is the accent again, which is how a person sees the wait is over.
    expect(sendButton().className).toContain("bg-message-action");
    expect(started).toHaveLength(0);
    expect(draft()).toBe("run the tests");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("run the tests");
  });

  it("sending on a paused workspace wakes it first and then starts the turn, in that order", async () => {
    const { api, started } = fixtureApi([{ ...workspace, phase: "napping" }]);
    const calls: string[] = [];
    let release!: () => void;
    api.wake = async id => {
      calls.push(`wake ${id}`);
      await new Promise<void>(resolve => (release = resolve));
      return { ...workspace, phase: "running" };
    };
    const start = api.startSession;
    api.startSession = async opts => {
      calls.push("start");
      return start(opts);
    };
    await setup(api);
    await typeInto(composerEditor(), "hello");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(calls).toEqual([`wake ${WS}`]));
    // While the machine wakes the box reads the waking state's own line; the start waits for the wake to settle.
    expect(useStore.getState().workspaces[0]!.phase).toBe("waking");
    expect(started).toHaveLength(0);
    release();
    await waitFor(() => expect(calls).toEqual([`wake ${WS}`, "start"]));
    expect(started[0]!.prompt).toBe("hello");
  });

  it("hands the sidebar the thread the runtime has written no row for yet", async () => {
    // A workspace nobody has sent to: this send opens a thread, it does not resume one, so no row exists for it.
    const { claudeSessionId: _none, ...fresh } = workspace;
    await setup(fixtureApi([fresh]).api);

    // The transcript draws the message on the send; the runtime writes its row only once the agent announces
    // itself, so between the two the send is the only thing the sidebar can draw for this thread.
    await typeInto(composerEditor(), "read the port list");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(useStore.getState().launches[WS]?.title).toBe("read the port list"));
    expect(useStore.getState().launches[WS]?.harness).toBe("claude");
  });

  it("a refused send takes its row back: it opened no thread", async () => {
    const { claudeSessionId: _none, ...fresh } = workspace;
    const { api } = fixtureApi([fresh]);
    let refuse!: (e: Error) => void;
    api.startSession = () => new Promise((_answer, reject) => (refuse = reject));
    await setup(api);
    await typeInto(composerEditor(), "read the port list");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(useStore.getState().launches[WS]).toBeDefined());
    await act(async () => {
      refuse(new Error("the workspace refused the turn"));
      await Promise.resolve();
    });
    await waitFor(() => expect(useStore.getState().launches[WS]).toBeUndefined());
  });

  it("on a window the host did not serve on this computer, a socket that drops reads as that computer asleep, not as wsp gone", async () => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPath: "/ws", paired: false, version: "0.0.0" };
    try {
      const { api } = fixtureApi([workspace]);
      await setup(api);
      act(() => useStore.getState().setConn("reconnecting"));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe(HOST_ASLEEP_SEND));
      expect(screen.getByRole("status").textContent).not.toBe(sendRefusal("reconnecting"));
      const send = screen.getByRole("button", { name: HOST_ASLEEP_SEND }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      expect(isEditable(composerEditor())).toBe(false);
      // A page the host served on this computer says what it has always said: wsp itself is not running here.
      (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPort: 7788, wsPath: "/ws", paired: true, version: "0.0.0", tokenHash: "a".repeat(64) };
      act(() => useStore.getState().setConn("closed"));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe(sendRefusal("closed")));
    } finally {
      delete (window as unknown as { __WSP__?: unknown }).__WSP__;
    }
  });

  it("a window on a sleeping Mac says which computer is asleep, ahead of anything that computer's daemon would say", async () => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPath: "/ws", paired: false, version: "0.0.0" };
    try {
      const here: WorkspaceView = { ...workspace, kind: "local", machineId: "local" };
      const { api } = fixtureApi([here]);
      await setup(api);
      // This window cannot reach the host at all: a daemon on the far side of it is not the block, and the reading
      // of it used to take the slot and read as though the daemon were the reason nothing could be sent.
      act(() => useStore.setState({ statuses: { [WS]: { ...here, machineState: "running", reach: { state: "unreachable" }, size: { cpu: 8, memMb: 16384 }, rateUsdPerHour: 0 } as never } }));
      act(() => useStore.getState().setConn("reconnecting"));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe(HOST_ASLEEP_SEND));
      expect(screen.getByRole("status").textContent).not.toContain("daemon is not running");
    } finally {
      delete (window as unknown as { __WSP__?: unknown }).__WSP__;
    }
  });

  it("a gone machine reads the same way: the gone sentence, one line, no panel", async () => {
    const { api } = fixtureApi([{ ...workspace, phase: "gone" }]);
    await setup(api);
    expect(isEditable(composerEditor())).toBe(false);
    expectPlainLine(sendRefusal("gone")!);
    expect(sendButton().getAttribute("aria-label")).toBe("Workspace machine is gone; rebuild it to send");
    expect(sendButton().disabled).toBe(true);
  });

  /** The composer on a workspace whose computer went quiet, by the road the places list takes: the row for its
   * computer stops answering while the record still says running. */
  async function onSilentComputer() {
    const onPlace: WorkspaceView = { ...workspace, kind: "cloud", machineId: "ctr_9f", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, place: "p_oldlaptop" };
    const fixture = fixtureApi([onPlace]);
    await setup(fixture.api);
    act(() =>
      useStore.setState({
        places: [
          { id: "here", kind: "computer", name: "this-mac", default: false, present: true },
          { id: "p_oldlaptop", kind: "computer", name: "old-laptop", default: true, present: false, lastSeenAt: new Date(Date.now() - 38 * 60_000).toISOString() },
        ],
      }),
    );
    return fixture;
  }

  it("a workspace on a computer that is not answering keeps its box open and holds the send alone", async () => {
    const { started } = await onSilentComputer();
    const held = composerHeldLine("old-laptop");
    // The standing refusal slot, not a toast: the person reads it where they are typing, and it stays there.
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(held));
    expect(held).toBe("held until old-laptop answers");
    // The box takes the words the wait is for. The line above it promises the send goes when the machine answers,
    // and a box that ate every keystroke made that promise a lie for five testers.
    expect(isEditable(composerEditor())).toBe(true);
    await typeInto(composerEditor(), "list the files in this repo");
    expect(draft()).toBe("list the files in this repo");
    // The send is the one thing held, in the tier every held send wears, and it says the same line.
    const send = screen.getByRole("button", { name: held }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.className).toContain("border-input");
    expect(send.className).toContain("bg-popover");
    expect(send.className).not.toContain("bg-message-action");
    expect(send.getAttribute("title")).toBe(held);
    // Not the state table's words, and no machine id where a person reads.
    expect(screen.queryByText(sendRefusal("unreachable")!)).toBeNull();
    expect(screen.getByRole("status").textContent).not.toContain("place:");
    // Enter leaves the words where they were typed and starts nothing, so no refusal comes back from the runtime.
    await press(composerEditor(), "Enter");
    expect(started).toHaveLength(0);
    expect(draft()).toBe("list the files in this repo");
    expect(lastNotice()).toBeNull();
    // The slot stands at two lines and the sentence wraps in it. At the smallest window with the right panel open
    // the slot is 296 px, so a slot that cut would drop the half that says what happens next, which is the half the
    // person needs. Measured at 1024 by 700 with the panel open: the slot's own class is what holds, since jsdom
    // lays nothing out.
    const box = slot()!;
    expect(box.className).toContain("h-9");
    expect(box.className).not.toContain("h-5");
    const said = screen.getByRole("status");
    expect(said.className).not.toContain("truncate");
    expect(said.className).toContain("text-pretty");
    expect(said.textContent).toBe(held);
  });

  it("the message a held composer holds goes on the person's own send once the computer answers, never before", async () => {
    const { started } = await onSilentComputer();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(composerHeldLine("old-laptop")));
    await typeInto(composerEditor(), "run the tests");
    act(() =>
      useStore.setState({
        places: [
          { id: "here", kind: "computer", name: "this-mac", default: false, present: true },
          { id: "p_oldlaptop", kind: "computer", name: "old-laptop", default: true, present: true, lastSeenAt: new Date().toISOString() },
        ],
      }),
    );
    // The computer answers. The words are still the person's: nothing leaves the box until they send it.
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(started).toHaveLength(0);
    expect(draft()).toBe("run the tests");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("run the tests");
  });

  it("a workspace whose machine stopped answering the probe holds the same way, named after where it runs", async () => {
    const { api, emit, started } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    // No places row for a fork at a provider, so the sentence names the fork's own where word rather than falling
    // back to the machine id, which names nothing to the person reading it.
    emit({ type: "workspace.status", status: { ...workspace, phase: "running", machineState: "running", reach: { state: "unreachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(composerHeldLine("a provider")));
    expect(isEditable(composerEditor())).toBe(true);
    await typeInto(composerEditor(), "check the disk");
    await press(composerEditor(), "Enter");
    expect(started).toHaveLength(0);
    expect(draft()).toBe("check the disk");
    expect(screen.getByRole("status").textContent).not.toContain("m1");
  });

  it("the slot takes no room while it holds no line, and room for two once a refusal lands", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    const empty = slot();
    expect(empty).not.toBeNull();
    expect(empty!.className).not.toMatch(/(^|\s)(min-)?h-/);
    expect(empty!.className).toContain("max-w-3xl");
    // The slot is the live region, present before any words land, so a screen reader hears the line when it does.
    expect(empty!.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("status")).toBeNull();
    emit({ type: "workspace.status", status: { ...workspace, phase: "waking", machineState: "starting", reach: { state: "napping" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 } });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeNull());
    expectPlainLine(sendRefusal("waking")!);
    expect(slot()!.className).toContain("min-h-9");
  });

  it("a pushed pausing status disables the send while the view still says running", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    emit({ type: "workspace.status", status: { ...workspace, phase: "pausing", machineState: "running", reach: { state: "napping" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Workspace is pausing; wake it to send"));
    expect(isEditable(composerEditor())).toBe(false);
  });

  it("disables the editor while the runtime socket is down and comes back with it", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api, "reconnecting");
    expect(isEditable(composerEditor())).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("wsp is not running, reconnecting");
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers stop while a turn streams, with no banner; Enter then queues the message above the box", async () => {
    const { api, emit, interrupted, started } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "go" });
    emit({ type: "session.delta", ...scope, kind: "text", text: "on it" });
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeDefined();
    expect(interrupted).toEqual([]);
    expect(screen.queryByRole("button", { name: /Send message|Turn in flight/ })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(isEditable(composerEditor())).toBe(true);
    await typeInto(composerEditor(), "follow up");
    await press(composerEditor(), "Enter");
    expect(draft()).toBe("");
    expect((screen.getByRole("textbox", { name: "Queued message" }) as HTMLTextAreaElement).value).toBe("follow up");
    expect(started).toHaveLength(0);
    emit({ type: "session.done", ...scope, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    emit({ type: "session.end", ...scope, exitCode: 0, sawResult: true });
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["follow up"]));
    expect(screen.queryByRole("textbox", { name: "Queued message" })).toBeNull();
  });
});

describe("a new thread while another thread of the workspace works", () => {
  const a = { workspaceId: WS, sessionId: "sess_a", turnId: "turn_a", threadId: "thr_a" };
  const WORKING: SessionEvent[] = [
    { type: "session.start", ...a, prompt: "build it", cwd: "/root" },
    { type: "session.delta", ...a, kind: "text", text: "On it." },
  ];

  it("the new-thread composer has no turn: sendable, no line, and its send opens a second thread while the first keeps working", async () => {
    const { api, emit, started } = fixtureApi([workspace], { [WS]: WORKING });
    await setup(api);
    await screen.findByText("On it.");
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeDefined();
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");
    const editor = composerEditor();
    expect(isEditable(editor)).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop generation" })).toBeNull();
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
    await typeInto(editor, "second thread");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toEqual({ workspaceId: WS, requestId: expect.any(String), prompt: "second thread" });
    expect(screen.getByText("second thread")).toBeDefined();
    // The first thread runs on: its next words are its own and never reach the new thread.
    emit({ type: "session.delta", ...a, kind: "text", text: " Still on it." });
    expect(screen.queryByText(/Still on it/)).toBeNull();
    const b = { workspaceId: WS, sessionId: "sess_b", turnId: "turn_b", threadId: "thr_b" };
    emit({ type: "session.start", ...b, prompt: "second thread", requestId: started[0]!.requestId });
    emit({ type: "session.delta", ...b, kind: "text", text: "Second thread here." });
    await screen.findByText("Second thread here.");
    expect(screen.queryByText("On it.")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeDefined();
  });

  it("the working thread's own composer still says so: its turn replied and runs on, and the line names that thread", async () => {
    const { api, emit } = fixtureApi([workspace], { [WS]: WORKING });
    await setup(api);
    await screen.findByText("On it.");
    expect(screen.queryByRole("status")).toBeNull();
    emit({ type: "session.done", ...a, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    // No title has landed for this thread yet, so the line names it as the person looking at it would.
    expectPlainLine(stillWorkingLine());
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    // A new thread asked for now owes that turn nothing.
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(isEditable(composerEditor())).toBe(true);
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
  });
});

/** The send control itself, queried where it sits rather than by the name it happens to be wearing: a held one
 * wears the reason it is held, which is not a name any list of send words can be written from. */
const sendControl = () => document.querySelector<HTMLButtonElement>('[data-chat-composer-actions="right"] button[type="submit"]')!;

/** The block reads the same in all three places a person meets it: the slot above the box, the name a screen
 * reader hears on the send, and the tooltip the held send carries. */
function expectHeld(words: string): void {
  expectPlainLine(words);
  expect(sendControl().getAttribute("aria-label")).toBe(words);
  expect(sendControl().getAttribute("title")).toBe(words);
  expect(sendControl().disabled).toBe(true);
  // Held is the tier ui/button.tsx gives a primary that cannot be pressed, not a fainter blue: five testers read a
  // lit arrow over a box that refused them as a screen saying it was ready to send.
  expect(sendControl().className).toContain("border-input");
  expect(sendControl().className).toContain("bg-popover");
  expect(sendControl().className).not.toContain("bg-message-action");
  expect(sendControl().className).not.toContain("disabled:opacity-30");
}

describe("a composer that cannot send yet", () => {
  it("an Enter while the link is down keeps the draft and leaves the reason standing in the slot", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "check the redirect chain");
    act(() => useStore.getState().setConn("reconnecting"));
    await waitFor(() => expect(isEditable(editor)).toBe(false));
    expectHeld(SEND_BLOCK_WORDS.reconnecting);
    await press(editor, "Enter");
    expect(draft()).toBe("check the redirect chain");
    expectHeld(SEND_BLOCK_WORDS.reconnecting);
    expect(started).toHaveLength(0);
  });

  it("the line goes when the link is up, the Enter that was dropped is not replayed, and the next one carries the draft once", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "check the redirect chain");
    act(() => useStore.getState().setConn("closed"));
    await waitFor(() => expect(isEditable(editor)).toBe(false));
    await press(editor, "Enter");
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(isEditable(editor)).toBe(true));
    expect(screen.queryByRole("status")).toBeNull();
    expect(slot()!.textContent).toBe("");
    expect(sendControl().getAttribute("title")).toBeNull();
    // The link coming back is not a send: the draft is still the person's to change or to throw away.
    expect(started).toHaveLength(0);
    expect(draft()).toBe("check the redirect chain");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("check the redirect chain");
    expect(draft()).toBe("");
  });

  it("a composer whose agents have not answered is held in the catalog's own words, and opens when they land", async () => {
    const { api, started } = fixtureApi([workspace]);
    let answered: HarnessCatalog[] = [];
    api.listHarnesses = async () => answered;
    await setup(api, "live", false);
    expectHeld(SEND_BLOCK_WORDS["no-agents"]);
    expect(isEditable(composerEditor())).toBe(false);
    // The harness that drives the built app waits on this word too, so a driven step cannot land on this window.
    expect(NOT_READY_NAMES).toContain(SEND_BLOCK_WORDS["no-agents"]);
    answered = [CLAUDE_CATALOG];
    await act(async () => { await useStore.getState().loadHarnesses(WS); });
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    expect(screen.queryByRole("status")).toBeNull();
    expect(started).toHaveLength(0);
    await typeInto(composerEditor(), "check the redirect chain");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("check the redirect chain");
  });

  it("the block outranks an image refusal already in the slot, so a held composer says one thing and it is the block", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "look at this");
    act(() => {
      fireEvent.paste(editor, { clipboardData: { files: [new File(["x"], "shot.png", { type: "image/png" })], getData: () => "" } });
    });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeNull());
    expect(screen.getByRole("status").textContent).not.toBe(SEND_BLOCK_WORDS.closed);
    act(() => useStore.getState().setConn("closed"));
    await waitFor(() => expect(isEditable(editor)).toBe(false));
    expectHeld(SEND_BLOCK_WORDS.closed);
  });
});

describe("composerSendBlock", () => {
  const live = { conn: "live" as const, hasApi: true, state: "running" as const, hydrated: true, agents: true };
  it("names the first thing in the way, socket first, as the kind the refusal table gives words for", () => {
    expect(composerSendBlock(live)).toBeNull();
    expect(composerSendBlock({ ...live, hasApi: false })).toBe("connecting");
    expect(composerSendBlock({ ...live, conn: "connecting" })).toBe("connecting");
    expect(composerSendBlock({ ...live, conn: "reconnecting", state: "paused" })).toBe("reconnecting");
    expect(composerSendBlock({ ...live, conn: "closed" })).toBe("closed");
    // No workspace and no status: the app has nothing to name a state of, which is the row a missing workspace gets.
    expect(composerSendBlock({ ...live, state: null })).toBe("not-found");
    expect(composerSendBlock({ ...live, state: "gone" })).toBe("gone");
    expect(composerSendBlock({ ...live, state: "paused" })).toBe("paused");
    expect(composerSendBlock({ ...live, state: "pausing" })).toBe("pausing");
    expect(composerSendBlock({ ...live, state: "waking" })).toBe("waking");
    expect(composerSendBlock({ ...live, state: "unreachable" })).toBe("unreachable");
    expect(composerSendBlock({ ...live, hydrated: false })).toBe("loading");
    expect(composerSendBlock({ ...live, agents: false })).toBe("no-agents");
  });

  it("holds nothing for a daemon this host started: the turn runs on this computer and never went through it", () => {
    // The state word folds a silent daemon into unreachable, which held the box on the computer the app is drawn
    // on while the very same build answered a turn from the command line in two seconds.
    expect(composerSendBlock({ ...live, state: "unreachable", absent: true, daemonOnly: true })).toBeNull();
    // Everything that is about the turn itself still holds it.
    expect(composerSendBlock({ ...live, state: "unreachable", absent: true, daemonOnly: true, hydrated: false })).toBe("loading");
    expect(composerSendBlock({ ...live, state: "unreachable", absent: true, daemonOnly: true, agents: false })).toBe("no-agents");
    expect(composerSendBlock({ ...live, conn: "closed", state: "unreachable", absent: true, daemonOnly: true })).toBe("closed");
    // A computer this host only waits for runs no turn, so its silence holds the box as it did.
    expect(composerSendBlock({ ...live, state: "unreachable", absent: true })).toBe("unreachable");
  });
});
