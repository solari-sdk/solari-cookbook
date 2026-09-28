// SPDX-License-Identifier: AGPL-3.0-only
// ChatView against a fixture event stream built in the @wsp/protocol
// vocabulary (shapes mirror packages/adapter-claude/test/fixtures/
// stream-session.jsonl). No live daemon; the fixture api replays history and
// pushes live events through the store's subscription.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeLayout } from "./fake-layout.js";
import type { EventUnion, HarnessCatalog, SessionEvent, SessionView, WorkspaceView } from "@wsp/protocol";
import { LIST_PRICE_WORD, QUESTION_TOOL, pickedOptionId, questionOptions } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { ChatView } from "../src/components/chat/ChatView.js";
import type { ChatThreadHandle } from "../src/components/chat/useChatThread.js";
import { CHAT_STREAM, CHAT_T0, CHAT_TURN, CHAT_WS } from "./fixtures/chat-stream.js";
import { requestNewThread } from "../src/shell/shellRequests.js";
import { useWorkspacePreviews } from "../src/shell/workspacePreviews.js";
import { getSyntaxHighlighterPromise } from "../src/lib/syntaxHighlighting.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

let restoreLayout: () => void = () => {};
// The fenced block's highlighter loads its wasm engine and grammar once per worker; cold, that load plus React's
// suspense reveal is 300 ms idle and outgrows the 1 s query wait under load, so it is paid here, not in a case.
beforeAll(async () => {
  restoreLayout = installFakeLayout();
  await getSyntaxHighlighterPromise("ts");
});
afterAll(() => restoreLayout());

const WS = CHAT_WS;

/** The agent's own model table as the composer's menu reads it: enough of one for the foot's two sentences. */
const CATALOG: HarnessCatalog = { harness: "claude", label: "Claude Code", source: "table", version: null, images: false, steers: false, renames: false, models: [{ value: "opus", label: "Opus" }], efforts: [], contextWindows: [], permissionModes: [] };

const scope = { workspaceId: WS, sessionId: "sess_0001", turnId: CHAT_TURN };
const T0 = CHAT_T0;

const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  // A fork, so its record carries the provider it was made at; that is the word the waking line names.
  provider: "solari",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "e16ed170-8257-4668-879e-fe836341633c",
};

// The shared stream plus one fenced code block in the closing text, so the highlighter has work.
const FIXTURE: EventUnion[] = [
  ...CHAT_STREAM.slice(0, 6),
  { type: "session.delta", ...scope, at: T0 + 9_300, kind: "text", text: "Server is live at :3000.\n\n```ts\nconst port: number = 3000;\n```\n" },
  ...CHAT_STREAM.slice(7),
];

function fixtureApi(workspaces: WorkspaceView[], history: Record<string, SessionEvent[]> = {}, sessions: SessionView[] = []) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
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
    listSessions: async () => sessions,
    watchStatuses: async () => [],
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => ({ id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running" }),
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, emit };
}

/** The composer's half of a send, since ChatView alone mounts no composer: the start that follows must carry this prompt. */
const sendFrom = (thread: ChatThreadHandle | null, prompt: string) => act(() => { thread!.setSending(true); thread!.appendUserTurn(prompt, "req_view"); });

async function setup(api: Api, workspaceId = WS) {
  useStore.getState().bind(api);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  const view = render(<ChatView workspaceId={workspaceId} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const settledTurn = (ws: string, prompt: string, text: string, n = 1): SessionEvent[] => {
  const sc = { workspaceId: ws, sessionId: `sess_${ws}`, turnId: `turn_${ws}_${n}` };
  const start = T0 + n * 60_000;
  return [
    { type: "session.start", ...sc, at: start, model: "claude-sonnet-4-5", prompt },
    { type: "session.delta", ...sc, at: start + 300, kind: "text", text },
    { type: "session.done", ...sc, at: start + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
    { type: "session.end", ...sc, at: start + 950, exitCode: 0, sawResult: true },
  ];
};

const THREAD = "thr_lastline";
const THREADED_SCOPE = { workspaceId: WS, sessionId: "sess_lastline", turnId: "turn_lastline", threadId: THREAD };

/** One settled turn stamped with a runtime thread id, which is what a switcher card matches a recorded line on. */
const threaded = (text: string): SessionEvent[] => [
  { type: "session.start", ...THREADED_SCOPE, at: T0, model: "claude-sonnet-4-5", prompt: "add a health route" },
  { type: "session.delta", ...THREADED_SCOPE, at: T0 + 300, kind: "text", text },
  { type: "session.done", ...THREADED_SCOPE, at: T0 + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
  { type: "session.end", ...THREADED_SCOPE, at: T0 + 950, exitCode: 0, sawResult: true },
];

describe("ChatView", () => {
  it("shows the empty-thread headline with the workspace name before any turn", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("What should we build in api?");
    expect(screen.queryByTestId("settled-footer")).toBeNull();
  });

  it("replays the persisted transcript on mount and shows the settled footer", async () => {
    const { api } = fixtureApi([workspace], { [WS]: settledTurn(WS, "add a health route", "Added GET /health.") });
    await setup(api);
    await screen.findByText("Added GET /health.");
    expect(screen.getByText("add a health route")).toBeDefined();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const footer = screen.getByTestId("settled-footer");
    expect(footer.textContent).toContain("Worked for");
    expect(footer.textContent).toContain("Worked for 900ms");
    // Every spend figure a person reads is in cents, whatever its size: a tenth of one reads $0.00, not $0.0010.
    expect(footer.textContent).toContain("$0.00");
  });

  it("renders the live fixture stream: grouped tool calls, collapsed thinking, highlighted code", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    // Up to and including the thinking delta: the turn is live.
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    emit({ type: "session.delta", workspaceId: "ws_other", sessionId: "s2", kind: "text", text: "alien text" });
    await screen.findByText(/Creating the server file, then starting it\./);
    expect(screen.queryByText("alien text")).toBeNull();
    // The live row names the latest activity: the command, or the reasoning that followed it.
    expect(screen.getByText(/Working for/)).toBeDefined();
    expect(screen.getAllByText(/Ran node|Thinking|curl returned the greeting/).length).toBeGreaterThan(0);

    for (const e of FIXTURE.slice(6)) emit(e);
    // Assistant text is markdown; the fenced block is highlighted by shiki once the highlighter resolves.
    await screen.findByText(/Server is live at :3000\./);
    await waitFor(() => {
      const shiki = document.querySelector(".chat-markdown-shiki");
      expect(shiki?.innerHTML ?? "").toContain('<span style="color:');
    });
    expect(screen.queryByText(/Working for/)).toBeNull();

    // A settled turn folds its work behind one line; the fold opens onto the grouped tool calls.
    const fold = screen.getByRole("button", { name: /Worked for 10s/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Ran 1 command/ })).toBeNull();
    fireEvent.click(fold);
    const toggle = screen.getByRole("button", { name: /Ran 1 command/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Hello, World!")).toBeNull();
    await act(async () => { fireEvent.click(toggle); });
    const group = await screen.findByRole("region", { name: "Tool calls" });
    const bashRow = within(group).getByRole("button", { name: /node \/root\/server\.js/ });
    expect(bashRow.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(bashRow);
    expect(within(group).getByText(/Hello, World!/)).toBeDefined();
    // Reasoning survives the settle as a row of its own; this one fits its preview, so there is nothing more to open.
    expect(within(group).getAllByText(/curl returned the greeting/)).toHaveLength(1);
    expect(within(group).queryByRole("button", { name: /curl returned the greeting/ })).toBeNull();

    const footer = screen.getByTestId("settled-footer");
    expect(footer.textContent).toContain("Worked for 10s");
    expect(footer.textContent).toContain("$0.02");
  });

  it("draws a fenced block in the side the page is drawing, and follows it when the computer's side changes", async () => {
    // index.html opens on the dark side and the preference flips it after the first paint. A side read once while
    // the transcript mounted stays wrong for as long as nothing else repaints, and a block highlighted for the
    // other side draws its line in the ink the box's own ground is.
    document.documentElement.classList.add("dark");
    try {
      const { api, emit } = fixtureApi([workspace]);
      await setup(api);
      for (const e of FIXTURE) emit(e);
      const shiki = () => document.querySelector(".chat-markdown-shiki .shiki")?.className ?? "";
      await waitFor(() => expect(shiki()).toContain("pierre-dark"));
      await act(async () => { document.documentElement.classList.remove("dark"); });
      await waitFor(() => expect(shiki()).toContain("pierre-light"));
      expect(document.querySelector(".chat-markdown-shiki .line")?.textContent).toContain("const port: number = 3000;");
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  it("says a figure on this computer is a list price, with no sentence behind it", async () => {
    const here: WorkspaceView = { ...workspace, id: "ws_here", name: "this computer", kind: "local", provider: undefined };
    const { api } = fixtureApi([here], { ws_here: settledTurn("ws_here", "add a health route", "Added GET /health.") });
    await setup(api, "ws_here");
    const figureNow = () => [...screen.getByTestId("settled-footer").querySelectorAll("span")].find(el => el.textContent?.includes(LIST_PRICE_WORD));

    // The word rides the figure from the first paint, off the workspace record alone: the catalog is not in the
    // store yet here, and a figure that stood bare and gained its word a moment later would be the change this
    // ticket took off the sidebar's cost line.
    const bare = await waitFor(() => {
      const found = figureNow();
      expect(found).toBeDefined();
      return found!;
    });
    expect(bare.textContent).toContain(`$0.00 ${LIST_PRICE_WORD}`);
    expect(bare.getAttribute("title")).toBeNull();

    // The catalog arriving adds nothing to the figure: no title rides it.
    act(() => useStore.setState({ harnesses: [CATALOG] }));
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });
    const figure = figureNow()!;
    expect(figure.textContent).toContain(`$0.00 ${LIST_PRICE_WORD}`);
    expect(figure.getAttribute("title")).toBeNull();
  });

  it("shows the working row while a turn runs and an error when it exits without a result", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "hi" });
    expect(screen.getByText(/Working/)).toBeDefined();
    emit({ type: "session.end", ...scope, exitCode: 137, sawResult: false });
    expect(screen.queryByText(/Working for/)).toBeNull();
    expect(screen.getByTestId("settled-footer").textContent).toContain("failed");
    expect(screen.getByText(/session exited without a result \(exit code 137\)/i)).toBeDefined();
  });

  it("a session the runtime ended for a nap shows its reason as the last row and settles the thread", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "hi" });
    emit({ type: "session.delta", ...scope, kind: "text", text: "Starting on it." });
    expect(screen.getByText(/Working/)).toBeDefined();
    emit({ type: "session.end", ...scope, exitCode: null, sawResult: false, reason: "machine paused while the agent was working" });
    expect(screen.queryByText(/Working for/)).toBeNull();
    const rows = [...document.querySelectorAll<HTMLElement>("[data-timeline-row-id]")];
    expect(rows.at(-1)?.textContent).toMatch(/machine paused while the agent was working/i);
    expect(screen.getByTestId("settled-footer").textContent).toContain("failed");
  });

  it("a turn in flight on a paused workspace waits for the machine with a Wake that calls the wake op; unreachable waits without one", async () => {
    const wakes: string[] = [];
    const { api, emit } = fixtureApi([workspace]);
    api.wake = async id => { wakes.push(id); return workspace; };
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "hi" });
    expect(screen.getByText(/Working/)).toBeDefined();
    const status = { ...workspace, machineState: "paused" as const, reach: { state: "napping" as const }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 };
    emit({ type: "workspace.status", status: { ...status, phase: "pausing" } });
    await screen.findByText("waiting for api to wake");
    expect(screen.queryByText(/Working for/)).toBeNull();
    expect(screen.queryByText("Thinking")).toBeNull();
    emit({ type: "workspace.napped", workspaceId: WS });
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    await waitFor(() => expect(wakes).toEqual([WS]));
    expect(useStore.getState().workspaces[0]!.phase).toBe("waking");
    await screen.findByText(/^waking api on solari/);
    expect(screen.queryByRole("button", { name: "Wake" })).toBeNull();
    emit({ type: "workspace.woken", workspaceId: WS, machineId: "m1", resurrected: false });
    emit({ type: "workspace.status", status: { ...status, phase: "running", machineState: "running", reach: { state: "unreachable" } } });
    await screen.findByText("waiting for api to answer");
    expect(screen.queryByRole("button", { name: "Wake" })).toBeNull();
    emit({ type: "workspace.status", status: { ...status, phase: "running", machineState: "running", reach: { state: "reachable" } } });
    await screen.findByText(/Working/);
    expect(screen.queryByText(/waiting for/)).toBeNull();
  });

  it("the send that wakes a paused workspace draws one mono rule line in the timeline, naming the workspace, where it runs and how long it has been waking", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "hi" });
    const status = { ...workspace, machineState: "paused" as const, reach: { state: "napping" as const }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 };
    emit({ type: "workspace.status", status: { ...status, phase: "waking" } });
    const line = await screen.findByText(/^waking api on solari/);
    const row = line.closest<HTMLElement>("[data-machine-wait]")!;
    expect(row.className).toContain("font-mono");
    expect(row.className).toContain("text-[11px]");
    expect(row.textContent).toMatch(/^waking api on solari \d+s$/);
    expect(row.querySelector("[role=alert], [data-slot=alert]")).toBeNull();
  });

  it("a paused workspace with nothing running says so once under the last turn, in the same mono rule line, with the idle window the runtime napped it after", async () => {
    const { api, emit } = fixtureApi([workspace], { [WS]: settledTurn(WS, "add a health route", "Added GET /health.") });
    await setup(api);
    await screen.findByText("Added GET /health.");
    expect(screen.queryByText(/^paused/)).toBeNull();
    const status = { ...workspace, machineState: "paused" as const, reach: { state: "napping" as const }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 };
    emit({ type: "workspace.status", status: { ...status, phase: "napping", reason: "idle 30 min" } });
    const line = (await screen.findByText("paused after 30 min idle")).closest<HTMLElement>("[data-workspace-paused]")!;
    expect(line.className).toContain("font-mono");
    expect(line.className).toContain("text-[11px]");
    // A nap this window did not see the reason for still says the state; nothing is invented about why.
    emit({ type: "workspace.status", status: { ...status, phase: "napping" } });
    await screen.findByText("paused");
    // It is the workspace's line, not a turn's: a running workspace draws none.
    emit({ type: "workspace.status", status: { ...status, phase: "running", machineState: "running", reach: { state: "reachable" } } });
    await waitFor(() => expect(screen.queryByText(/^paused/)).toBeNull());
  });

  it("clears to the empty headline on a new-thread request and shows the fresh turn that follows", async () => {
    const { api, emit } = fixtureApi([workspace], { [WS]: settledTurn(WS, "add a health route", "Added GET /health.") });
    const handle: { current: ChatThreadHandle | null } = { current: null };
    useStore.getState().bind(api);
    await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
    render(<ChatView workspaceId={WS}>{thread => { handle.current = thread; return null; }}</ChatView>);
    await screen.findByText("Added GET /health.");
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");
    expect(screen.queryByText("Added GET /health.")).toBeNull();
    sendFrom(handle.current, "second thread");
    for (const e of settledTurn(WS, "second thread", "Second answer.", 2)) emit(e);
    await screen.findByText("Second answer.");
    expect(screen.getByText("second thread")).toBeDefined();
    expect(screen.queryByText("Added GET /health.")).toBeNull();
  });

  it("keeps a new-thread request that lands before the history reply", async () => {
    const { api } = fixtureApi([workspace]);
    let release: (events: SessionEvent[]) => void = () => {};
    api.sessionHistory = () => new Promise<SessionEvent[]>(resolve => { release = resolve; });
    useStore.getState().bind(api);
    await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
    render(<ChatView workspaceId={WS}>{thread => <span data-testid="fresh">{String(thread.fresh)}</span>}</ChatView>);
    expect(screen.getByText("loading transcript")).toBeDefined();
    act(() => requestNewThread({ workspaceId: WS }));
    act(() => release(settledTurn(WS, "add a health route", "Added GET /health.")));
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");
    expect(screen.queryByText("Added GET /health.")).toBeNull();
    expect(screen.getByTestId("fresh").textContent).toBe("true");
  });

  it("honours a new-thread request raised for a workspace whose chat was not mounted yet", async () => {
    const other: WorkspaceView = { ...workspace, id: "ws_chat0002", name: "beta" };
    const { api } = fixtureApi([workspace, other], {
      [WS]: settledTurn(WS, "alpha prompt", "Alpha answer."),
      [other.id]: settledTurn(other.id, "beta prompt", "Beta answer."),
    });
    const view = await setup(api);
    await screen.findByText("Alpha answer.");
    // The palette selects the workspace and requests in one handler, before beta's chat exists.
    act(() => requestNewThread({ workspaceId: other.id }));
    expect(screen.getByText("Alpha answer.")).toBeDefined();
    view.rerender(<ChatView workspaceId={other.id} />);
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in beta?");
    expect(screen.queryByText("Beta answer.")).toBeNull();
    // Taken once: mounting alpha again shows alpha's transcript.
    view.rerender(<ChatView workspaceId={WS} />);
    await screen.findByText("Alpha answer.");
  });

  it("drops the left turn's remaining events after a new thread is requested mid-turn and is never busy for it", async () => {
    const { api, emit } = fixtureApi([workspace]);
    const handle: { current: ChatThreadHandle | null } = { current: null };
    useStore.getState().bind(api);
    await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
    render(<ChatView workspaceId={WS}>{thread => { handle.current = thread; return <span data-testid="busy">{String(thread.busy)}</span>; }}</ChatView>);
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    await screen.findByText(/Creating the server file, then starting it\./);
    expect(screen.getByTestId("busy").textContent).toBe("true");
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");
    expect(screen.getByTestId("busy").textContent).toBe("false");
    for (const e of FIXTURE.slice(6)) emit(e);
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText(/Server is live at :3000\./)).toBeNull();
    expect(screen.queryByTestId("settled-footer")).toBeNull();
    expect(screen.getByTestId("busy").textContent).toBe("false");
    sendFrom(handle.current, "start over");
    const fresh = { workspaceId: WS, sessionId: "sess_0002", turnId: "turn_0002" };
    emit({ type: "session.start", ...fresh, at: T0 + 100_000, prompt: "start over" });
    emit({ type: "session.delta", ...fresh, at: T0 + 100_500, kind: "text", text: "Fresh start." });
    await screen.findByText("Fresh start.");
    expect(screen.getByText("start over")).toBeDefined();
  });

  it("a running turn in the history reply of a pre-mount request is not the new thread's: the view stays empty and is never busy for it", async () => {
    const other: WorkspaceView = { ...workspace, id: "ws_chat0002", name: "beta" };
    const beta = { workspaceId: other.id, sessionId: "sess_beta", turnId: "turn_beta" };
    const betaHistory: SessionEvent[] = [
      { type: "session.start", ...beta, at: T0, model: "claude-sonnet-4-5", prompt: "beta prompt" },
      { type: "session.delta", ...beta, at: T0 + 300, kind: "text", text: "Beta is thinking about it." },
    ];
    const { api, emit } = fixtureApi([workspace, other], { [WS]: settledTurn(WS, "alpha prompt", "Alpha answer."), [other.id]: betaHistory });
    useStore.getState().bind(api);
    await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
    const view = render(<ChatView workspaceId={WS}>{thread => <span data-testid="busy">{String(thread.busy)}</span>}</ChatView>);
    await screen.findByText("Alpha answer.");
    act(() => requestNewThread({ workspaceId: other.id }));
    view.rerender(<ChatView workspaceId={other.id}>{thread => <span data-testid="busy">{String(thread.busy)}</span>}</ChatView>);
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in beta?");
    expect(screen.getByTestId("busy").textContent).toBe("false");
    emit({ type: "session.delta", ...beta, at: T0 + 600, kind: "text", text: " and the beta tail." });
    emit({ type: "session.done", ...beta, at: T0 + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
    expect(screen.queryByText(/beta tail/)).toBeNull();
    expect(screen.queryByTestId("settled-footer")).toBeNull();
    expect(screen.getByTestId("busy").textContent).toBe("false");
    emit({ type: "session.end", ...beta, at: T0 + 950, exitCode: 0, sawResult: true });
    expect(screen.getByTestId("busy").textContent).toBe("false");
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
  });

  it("records nothing as it draws: the previews store is the shell's pictures alone", async () => {
    const held = useWorkspacePreviews.getState();
    expect(Object.keys(held)).toEqual(["images", "setImages"]);
    const { api, emit } = fixtureApi([workspace], { [WS]: threaded("Ran the gate.\n\nAll 12 tests green.\n") });
    await setup(api);
    await screen.findByText(/All 12 tests green\./);
    // A whole transcript drawn and a turn streaming over it: the store the switcher reads is not written to once.
    emit({ type: "session.delta", ...THREADED_SCOPE, at: T0 + 120_000, kind: "text", text: "\nBumped the lockfile.\n" });
    await waitFor(() => expect(screen.getAllByText(/Bumped the lockfile\./).length).toBeGreaterThan(0));
    expect(useWorkspacePreviews.getState()).toBe(held);
  });

  it("virtualizes a long transcript instead of mounting every row", async () => {
    const turns = 300;
    const history = Array.from({ length: turns }, (_, i) => settledTurn(WS, `prompt ${i}`, `answer ${i}`, i)).flat();
    const { api } = fixtureApi([workspace], { [WS]: history });
    await setup(api);
    await screen.findByText("answer 299");
    const mounted = document.querySelectorAll("[data-timeline-root]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(turns);
  });

  it("draws the question the thread it is waiting on has open, says it is waiting, and answers that thread's turn", async () => {
    // The thread on screen was asked nothing. Its own call is a wsp send into another thread, and that thread is
    // stopped on a question: with only its own row to read it said Working with nothing to click.
    const sc = { workspaceId: WS, sessionId: "sess_caller", turnId: "turn_caller", threadId: "thr_caller" };
    const history: SessionEvent[] = [
      { type: "session.start", ...sc, at: T0, model: "claude-sonnet-5", prompt: "ask the other one" },
      { type: "session.delta", ...sc, at: T0 + 100, kind: "tool_use", text: JSON.stringify({ thread: "thr_target", message: "read hello.txt" }), toolName: "mcp__wsp__send", toolUseId: "toolu_send" },
    ];
    const waitingOn = {
      threadId: "thr_target",
      workspaceId: "ws_other",
      sessionId: "sess_target",
      title: "read the file",
      prompt: {
        askId: "ask_target",
        toolName: "Write",
        input: '{"file_path":"/root/hello.txt","content":"hi"}',
        options: [
          { id: "allow", label: "Allow", effect: "allow" as const },
          { id: "deny", label: "Deny", effect: "deny" as const },
        ],
      },
    };
    const caller: SessionView = { id: "sess_caller", workspaceId: WS, harness: "claude", status: "running", threadId: "thr_caller", waitingOn };
    const rows: SessionView[] = [caller];
    const { api, emit } = fixtureApi([workspace], { [WS]: history }, rows);
    const answered: { sessionId: string; askId: string; optionId: string }[] = [];
    api.answerPermission = async (sessionId, askId, optionId) => {
      answered.push({ sessionId, askId, optionId });
      return "answered";
    };
    await setup(api);

    const row = await waitFor(() => {
      const drawn = document.querySelector<HTMLElement>('[data-permission-prompt="ask_target"]');
      expect(drawn).not.toBeNull();
      return drawn!;
    });
    expect(row.getAttribute("data-permission-open")).toBe("true");
    // Whose question it is, said above it, since the thread being read did not raise it.
    expect(row.querySelector("[data-permission-asker]")!.textContent).toBe("read the file asks; this thread waits on the answer");
    expect(within(row).getByText("Write hello.txt in root (2 B)")).toBeDefined();
    expect([...row.querySelectorAll("[data-permission-option]")].map(b => b.textContent)).toEqual(["Allow", "Deny"]);
    // The count says the thread is stopped on a question rather than working.
    expect(document.body.textContent).toContain("Waiting for you");
    expect(document.body.textContent).not.toContain("Working for");

    // The answer goes to the other thread's turn, which is what ends both waits.
    fireEvent.click(row.querySelector('[data-permission-option="allow"]')!);
    await waitFor(() => expect(answered).toEqual([{ sessionId: "sess_target", askId: "ask_target", optionId: "allow" }]));

    // The runtime takes the wait off the row once the question is answered; the row is what this screen reads.
    rows[0] = { ...caller, waitingOn: undefined };
    emit({ type: "session.permission.closed", workspaceId: "ws_other", sessionId: "sess_target", turnId: "turn_target", threadId: "thr_target", at: T0 + 900, askId: "ask_target", outcome: "allowed", optionId: "allow" });
    await waitFor(() => expect(document.querySelector('[data-permission-prompt="ask_target"]')).toBeNull());
    expect(document.body.textContent).toContain("Working for");
  });

  it("relays a permission prompt as its own row, answers it from the chat, and closes the row on the runtime's event", async () => {
    const sc = { workspaceId: WS, sessionId: "sess_perm", turnId: "turn_perm" };
    const ask = {
      type: "session.permission" as const,
      ...sc,
      at: T0 + 500,
      askId: "ask_1",
      toolName: "Write",
      toolUseId: "toolu_1",
      input: '{"file_path":"/root/out.txt","content":"hi"}',
      detail: "out.txt",
      options: [
        { id: "allow", label: "Allow", effect: "allow" as const },
        { id: "deny", label: "Deny", effect: "deny" as const },
        { id: "mode:acceptEdits", label: "Allow, then Accept edits", effect: "mode" as const, mode: "acceptEdits" },
      ],
    };
    const history: SessionEvent[] = [{ type: "session.start", ...sc, at: T0, model: "claude-sonnet-5", prompt: "write it" }, ask];
    const { api, emit } = fixtureApi([workspace], { [WS]: history });
    const answered: { sessionId: string; askId: string; optionId: string }[] = [];
    api.answerPermission = async (sessionId, askId, optionId) => {
      answered.push({ sessionId, askId, optionId });
      return "answered";
    };
    await setup(api);

    const row = await waitFor(() => document.querySelector<HTMLElement>('[data-permission-prompt="ask_1"]')!);
    expect(row.getAttribute("data-permission-open")).toBe("true");
    // A sentence, not the tool's code name and not the file: what is being written, where, and how much of it.
    expect(within(row).getByText("Write out.txt in root (2 B)")).toBeDefined();
    // The file's own text is behind a fold, so the question and the buttons are what the row opens with.
    expect(row.querySelector("[data-permission-body]")).toBeNull();
    const fold = row.querySelector<HTMLElement>("[data-permission-body-trigger]")!;
    expect(fold.textContent).toBe("show the file");
    fireEvent.click(fold);
    const body = await waitFor(() => row.querySelector<HTMLElement>("[data-permission-body]")!);
    expect(body.textContent).toBe("hi");
    expect(body.className).toContain("font-mono");
    expect(body.className).toContain("text-muted-foreground");
    // Every option the harness offered, as buttons: nothing here is a chip or a badge.
    expect([...row.querySelectorAll("[data-permission-option]")].map(b => b.textContent)).toEqual(["Allow", "Deny", "Allow, then Accept edits"]);

    fireEvent.click(row.querySelector('[data-permission-option="allow"]')!);
    await waitFor(() => expect(answered).toEqual([{ sessionId: "sess_perm", askId: "ask_1", optionId: "allow" }]));
    // The row closes on the runtime's event, not on the reply here, so two clients watching one prompt agree.
    expect(document.querySelector('[data-permission-prompt="ask_1"]')!.getAttribute("data-permission-open")).toBe("true");

    emit({ type: "session.permission.closed", ...sc, at: T0 + 900, askId: "ask_1", outcome: "allowed", optionId: "allow" });
    await waitFor(() => expect(document.querySelector('[data-permission-prompt="ask_1"]')!.getAttribute("data-permission-open")).toBe("false"));
    const closed = document.querySelector<HTMLElement>('[data-permission-prompt="ask_1"]')!;
    expect(closed.querySelectorAll("[data-permission-option]")).toHaveLength(0);
    // The option's name is left off where it repeats the outcome; a mode pick is the one that adds to it.
    expect(within(closed).getByText("Allowed")).toBeDefined();
    expect(closed.querySelector("[data-permission-outcome]")!.getAttribute("data-permission-outcome")).toBe("allowed");
  });

  it("draws a harness question as the question it is, one button per option, and the pick answers the prompt", async () => {
    const sc = { workspaceId: WS, sessionId: "sess_q", turnId: "turn_q" };
    const input = JSON.stringify({
      questions: [
        {
          question: "This working directory is not a repository. What should I do?",
          header: "Directory",
          options: [
            { label: "Clone it", description: "Fetch the remote into this folder." },
            { label: "Start fresh", description: "Run git init here." },
            { label: "Stop", description: "Do nothing and wait." },
          ],
          multiSelect: false,
        },
      ],
    });
    const options = questionOptions(QUESTION_TOOL, input);
    const ask = {
      type: "session.permission" as const,
      ...sc,
      at: T0 + 500,
      askId: "ask_q",
      toolName: QUESTION_TOOL,
      toolUseId: "toolu_q",
      input,
      options,
    };
    const history: SessionEvent[] = [{ type: "session.start", ...sc, at: T0, model: "claude-sonnet-5", prompt: "set it up" }, ask];
    const { api, emit } = fixtureApi([workspace], { [WS]: history });
    const answered: { sessionId: string; askId: string; optionId: string }[] = [];
    api.answerPermission = async (sessionId, askId, optionId) => {
      answered.push({ sessionId, askId, optionId });
      return "answered";
    };
    await setup(api);

    const row = await waitFor(() => document.querySelector<HTMLElement>('[data-permission-prompt="ask_q"]')!);
    // The question's own header and sentence, and not a word of the harness's code name for the tool.
    expect(row.querySelector("[data-question-header]")!.textContent).toBe("Directory");
    expect(row.querySelector("[data-question-text]")!.textContent).toBe("This working directory is not a repository. What should I do?");
    expect(row.textContent).not.toContain(QUESTION_TOOL);
    expect(row.textContent).not.toContain("Permission for");
    // Nor does the call's own row above it: the harness's name for the tool is nowhere on the screen.
    expect(document.body.textContent).not.toContain(QUESTION_TOOL);
    // No raw input anywhere on it: no JSON punctuation, no field names.
    for (const raw of ["multiSelect", '"questions"', "[{", "}]"]) expect(row.textContent).not.toContain(raw);
    // One button per option, each with its own sentence under it, and no allow step in front of them.
    const buttons = [...row.querySelectorAll<HTMLElement>("[data-question-option]")];
    expect(buttons).toHaveLength(3);
    expect(buttons.map(b => b.querySelector("[data-question-description]")!.textContent)).toEqual([
      "Fetch the remote into this folder.",
      "Run git init here.",
      "Do nothing and wait.",
    ]);
    expect(row.querySelectorAll("[data-permission-option]")).toHaveLength(0);
    expect(row.textContent).not.toContain("Allow");
    expect(row.textContent).not.toContain("Deny");

    // The button keeps the one shape every button here has; its sentence sits under it.
    expect(buttons.map(b => b.querySelector("button")!.textContent)).toEqual(["Clone it", "Start fresh", "Stop"]);
    fireEvent.click(buttons[1]!.querySelector("button")!);
    await waitFor(() => expect(answered).toEqual([{ sessionId: "sess_q", askId: "ask_q", optionId: options[1]!.id }]));

    emit({ type: "session.permission.closed", ...sc, at: T0 + 900, askId: "ask_q", outcome: "allowed", optionId: options[1]!.id });
    const closed = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-permission-prompt="ask_q"]')!;
      expect(el.getAttribute("data-permission-open")).toBe("false");
      return el;
    });
    // A closed question says what the person answered; "Allowed" says nothing about an answer.
    expect(within(closed).getByText("You answered: Start fresh")).toBeDefined();
  });

  it("a question that takes several answers draws boxes and one Answer button, and sends every tick as one pick", async () => {
    const sc = { workspaceId: WS, sessionId: "sess_qm", turnId: "turn_qm" };
    const input = JSON.stringify({
      questions: [
        {
          question: "Which checks should the gate run?",
          header: "Checks",
          options: [{ label: "Types" }, { label: "Tests" }, { label: "Lint" }],
          multiSelect: true,
        },
      ],
    });
    const options = questionOptions(QUESTION_TOOL, input);
    const history: SessionEvent[] = [
      { type: "session.start", ...sc, at: T0, model: "claude-sonnet-5", prompt: "gate it" },
      { type: "session.permission", ...sc, at: T0 + 500, askId: "ask_qm", toolName: QUESTION_TOOL, input, options },
    ];
    const { api } = fixtureApi([workspace], { [WS]: history });
    const answered: string[] = [];
    api.answerPermission = async (_sessionId, _askId, optionId) => {
      answered.push(optionId);
      return "answered";
    };
    await setup(api);

    const row = await waitFor(() => document.querySelector<HTMLElement>('[data-permission-prompt="ask_qm"]')!);
    const boxes = [...row.querySelectorAll<HTMLElement>('[data-question-option] [data-slot="checkbox"]')];
    expect(boxes).toHaveLength(3);
    const answer = row.querySelector<HTMLButtonElement>("[data-question-answer]")!;
    // Nothing is ticked, so there is nothing to answer with yet.
    expect(answer.disabled).toBe(true);

    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[2]!);
    await waitFor(() => expect(row.querySelector<HTMLButtonElement>("[data-question-answer]")!.disabled).toBe(false));
    fireEvent.click(row.querySelector<HTMLElement>("[data-question-answer]")!);
    // One pick closes one prompt, so both ticks travel as one id the protocol reads back as two options.
    await waitFor(() => expect(answered).toEqual([pickedOptionId([options[0]!.id, options[2]!.id])]));
  });

  it("draws two subagents under two folds titled by their tasks, with each one's prompt inside its own fold", async () => {
    const sc = { workspaceId: WS, sessionId: "sess_sub", turnId: "turn_sub" };
    const launch = (id: string, description: string, at: number): SessionEvent => ({
      type: "session.delta", ...sc, at, kind: "tool_use", toolName: "Agent", toolUseId: id,
      text: JSON.stringify({ description, prompt: "go" }),
    });
    const said = (parent: string, text: string, at: number): SessionEvent => ({
      type: "session.delta", ...sc, at, kind: "text", text, parentToolUseId: parent,
    });
    const history: SessionEvent[] = [
      { type: "session.start", ...sc, at: T0, model: "claude-sonnet-5", prompt: "fan out" },
      { type: "session.delta", ...sc, at: T0 + 100, kind: "text", text: "Launching two." },
      launch("toolu_a", "count alpha files", T0 + 200),
      launch("toolu_b", "read beta hostname", T0 + 300),
      said("toolu_a", "I'll verify the repo contents myself first.", T0 + 400),
      said("toolu_b", "I'll verify the repo contents myself first.", T0 + 500),
      {
        type: "session.permission", ...sc, at: T0 + 600, askId: "ask_a", toolName: "Bash",
        toolUseId: "toolu_a1", parentToolUseId: "toolu_a", input: '{"command":"ls /etc"}',
        options: [{ id: "allow", label: "Allow", effect: "allow" }, { id: "deny", label: "Deny", effect: "deny" }],
      },
    ];
    const { api } = fixtureApi([workspace], { [WS]: history });
    const answered: { askId: string; optionId: string }[] = [];
    api.answerPermission = async (_sessionId, askId, optionId) => {
      answered.push({ askId, optionId });
      return "answered";
    };
    await setup(api);

    const folds = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[data-subagent]")];
      expect(found).toHaveLength(2);
      return found;
    });
    // One fold per subagent, in the order they were launched, each titled by its own task.
    expect(folds.map(f => f.getAttribute("data-subagent"))).toEqual(["toolu_a", "toolu_b"]);
    expect(folds.map(f => f.querySelector("[data-subagent-title]")!.textContent)).toEqual(["count alpha files", "read beta hostname"]);
    // The parent's own sentence is its own row; neither child's is glued to it.
    const parentSaid = [...document.querySelectorAll('[data-message-role="assistant"]')].map(n => n.textContent ?? "");
    expect(parentSaid.some(text => text.includes("Launching two."))).toBe(true);
    for (const text of parentSaid) expect(text).not.toContain("I'll verify the repo contents myself first.");
    // The prompt sits inside the agent that raised it, under that agent's name, and nowhere in the flat stream.
    const inside = within(folds[0]!).getByText("count alpha files asks");
    expect(inside).toBeDefined();
    expect(folds[1]!.querySelector("[data-permission-prompt]")).toBeNull();
    const prompt = folds[0]!.querySelector<HTMLElement>('[data-permission-prompt="ask_a"]')!;
    fireEvent.click(prompt.querySelector('[data-permission-option="allow"]')!);
    await waitFor(() => expect(answered).toEqual([{ askId: "ask_a", optionId: "allow" }]));
  });

  it("opens a subagent's fold when its prompt arrives after the fold is already on the screen", async () => {
    const sc = { workspaceId: WS, sessionId: "sess_late", turnId: "turn_late" };
    const history: SessionEvent[] = [
      { type: "session.start", ...sc, at: T0, model: "claude-sonnet-5", prompt: "fan out" },
      {
        type: "session.delta", ...sc, at: T0 + 100, kind: "tool_use", toolName: "Agent", toolUseId: "toolu_a",
        text: JSON.stringify({ description: "count alpha files", prompt: "go" }),
      },
      { type: "session.delta", ...sc, at: T0 + 200, kind: "text", text: "checking", parentToolUseId: "toolu_a" },
    ];
    const { api, emit } = fixtureApi([workspace], { [WS]: history });
    const answered: { askId: string; optionId: string }[] = [];
    api.answerPermission = async (_sessionId, askId, optionId) => {
      answered.push({ askId, optionId });
      return "answered";
    };
    await setup(api);

    // The fold is drawn first, with nothing waiting on it: a person may leave it shut.
    const fold = await waitFor(() => document.querySelector<HTMLElement>('[data-subagent="toolu_a"]')!);
    expect(fold.querySelector("[data-permission-prompt]")).toBeNull();

    // The question arrives while that fold stands. A shut fold would hide it and the turn would wait forever.
    emit({
      type: "session.permission", ...sc, at: T0 + 300, askId: "ask_late", toolName: "Bash",
      toolUseId: "toolu_a1", parentToolUseId: "toolu_a", input: '{"command":"ls /etc"}',
      options: [{ id: "allow", label: "Allow", effect: "allow" }, { id: "deny", label: "Deny", effect: "deny" }],
    });
    const prompt = await waitFor(() => {
      // A shut fold unmounts its panel, so the prompt is not merely hidden: it is not in the page at all.
      const el = document.querySelector<HTMLElement>('[data-subagent="toolu_a"] [data-permission-prompt="ask_late"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(document.querySelector<HTMLElement>('[data-subagent="toolu_a"]')!).getByText("count alpha files asks")).toBeDefined();
    fireEvent.click(prompt.querySelector('[data-permission-option="allow"]')!);
    await waitFor(() => expect(answered).toEqual([{ askId: "ask_late", optionId: "allow" }]));
  });

  it("lets a person shut a subagent's fold again once nothing is waiting on it", async () => {
    const sc = { workspaceId: WS, sessionId: "sess_shut", turnId: "turn_shut" };
    const history: SessionEvent[] = [
      { type: "session.start", ...sc, at: T0, model: "claude-sonnet-5", prompt: "fan out" },
      {
        type: "session.delta", ...sc, at: T0 + 100, kind: "tool_use", toolName: "Agent", toolUseId: "toolu_a",
        text: JSON.stringify({ description: "count alpha files", prompt: "go" }),
      },
      { type: "session.delta", ...sc, at: T0 + 200, kind: "text", text: "checking", parentToolUseId: "toolu_a" },
      {
        type: "session.permission", ...sc, at: T0 + 300, askId: "ask_shut", toolName: "Bash",
        toolUseId: "toolu_a1", parentToolUseId: "toolu_a", input: '{"command":"ls /etc"}',
        options: [{ id: "allow", label: "Allow", effect: "allow" }],
      },
      { type: "session.permission.closed", ...sc, at: T0 + 400, askId: "ask_shut", outcome: "allowed", optionId: "allow" },
    ];
    const { api, emit } = fixtureApi([workspace], { [WS]: history });
    await setup(api);

    const trigger = await waitFor(() => document.querySelector<HTMLElement>('[data-subagent="toolu_a"] [data-subagent-trigger]')!);
    fireEvent.click(trigger);
    await waitFor(() => expect(document.querySelector('[data-subagent="toolu_a"] [data-subagent-title]')).not.toBeNull());
    // Nothing is waiting, so the person's own toggle stands and a later line of the agent's does not reopen it.
    const shut = document.querySelector<HTMLElement>('[data-subagent="toolu_a"] [data-subagent-trigger]')!.getAttribute("aria-expanded");
    emit({ type: "session.delta", ...sc, at: T0 + 500, kind: "text", text: " and again", parentToolUseId: "toolu_a" });
    await waitFor(() => expect(document.querySelector<HTMLElement>('[data-subagent="toolu_a"] [data-subagent-trigger]')!.getAttribute("aria-expanded")).toBe(shut));
  });

  it("a prompt nobody answered reads as denied by wsp, and one that went with its turn as cancelled", async () => {
    const sc = { workspaceId: WS, sessionId: "sess_perm2", turnId: "turn_perm2" };
    const ask = (askId: string) => ({
      type: "session.permission" as const,
      ...sc,
      at: T0 + 500,
      askId,
      toolName: "Bash",
      input: '{"command":"rm -rf build"}',
      options: [
        { id: "allow", label: "Allow", effect: "allow" as const },
        { id: "deny", label: "Deny", effect: "deny" as const },
      ],
    });
    const history: SessionEvent[] = [
      { type: "session.start", ...sc, at: T0, model: "claude-sonnet-5", prompt: "clean it" },
      ask("ask_wait"),
      { type: "session.permission.closed", ...sc, at: T0 + 900, askId: "ask_wait", outcome: "unanswered" },
      ask("ask_stop"),
      { type: "session.permission.closed", ...sc, at: T0 + 1_000, askId: "ask_stop", outcome: "cancelled" },
    ];
    const { api } = fixtureApi([workspace], { [WS]: history });
    await setup(api);
    const waited = await waitFor(() => document.querySelector<HTMLElement>('[data-permission-prompt="ask_wait"]')!);
    expect(within(waited).getByText("Nobody answered; denied")).toBeDefined();
    // A command is the whole command on the lead, with no code name in front of it, and it is drawn as code beside
    // the words rather than inside them, so the sentence face never closes two hyphens into one dash.
    expect(waited.querySelector("[data-permission-says]")!.textContent).toBe("Run:");
    const command = waited.querySelector<HTMLElement>("[data-permission-code]")!;
    expect(command.textContent).toBe("rm -rf build");
    expect(command.className).toContain("font-mono");
    expect(command.className).toContain("break-normal");
    expect(command.className).toContain("overflow-x-auto");
    const stopped = document.querySelector<HTMLElement>('[data-permission-prompt="ask_stop"]')!;
    expect(within(stopped).getByText("Cancelled with the turn")).toBeDefined();
    // Neither offers an option any more: there is nothing left to pick.
    for (const row of [waited, stopped]) expect(row.querySelectorAll("[data-permission-option]")).toHaveLength(0);
  });
});

describe("the threads a thread opened", () => {
  const BENCH: WorkspaceView = { id: "ws_bench", name: "spoo-bench", machineId: "m2", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, provider: "ascii", phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };
  const PARENT = "thr_lead";
  const scoped = { workspaceId: WS, sessionId: "sess_lead", turnId: "turn_lead", threadId: PARENT };
  const lead: SessionEvent[] = [
    { type: "session.start", ...scoped, at: T0, model: "claude-sonnet-5", prompt: "run the migration across the fleet" },
    { type: "session.delta", ...scoped, at: T0 + 300, kind: "text", text: "Three workspaces are up." },
    { type: "session.done", ...scoped, at: T0 + 900, result: { status: "completed", durationMs: 178_000, costUsd: 1.14 } },
    { type: "session.end", ...scoped, at: T0 + 950, exitCode: 0, sawResult: true },
  ];
  const rows: SessionView[] = [
    { id: "sess_lead", workspaceId: WS, harness: "claude", status: "completed", threadId: PARENT, prompt: "run the migration across the fleet", costUsd: 1.14 },
    { id: "sess_bench", workspaceId: "ws_bench", harness: "claude", status: "running", startedBy: "agent", threadId: "thr_bench", parentThreadId: PARENT, prompt: "benchmark the new index", costUsd: 2 },
    { id: "sess_web", workspaceId: WS, harness: "claude", status: "failed", startedBy: "agent", threadId: "thr_web", parentThreadId: PARENT, prompt: "rewrite the web client", costUsd: 0.3 },
  ];

  it("each get a row in the opener's transcript naming the thread, its workspace, where it runs and its state, with the page's own address for it", async () => {
    const { api } = fixtureApi([workspace, BENCH], { [WS]: lead }, rows);
    await setup(api);
    await screen.findByText("Three workspaces are up.");
    const opened = await waitFor(() => {
      const found = Array.from(document.querySelectorAll<HTMLElement>("[data-opened-thread]"));
      expect(found).toHaveLength(2);
      return found;
    });
    expect(opened.map(row => row.textContent)).toEqual([
      "openedbenchmark the new index spoo-bench on ascii Working",
      "openedrewrite the web client api on solari Failed",
    ]);
    const link = opened[0]!.querySelector<HTMLAnchorElement>("a")!;
    expect(link.textContent).toBe("benchmark the new index");
    expect(link.getAttribute("href")).toBe(`${window.location.origin}${window.location.pathname}#w/ws_bench/t/thr_bench`);
    // Clicking it walks down the tree the same way the child's own header walks up it.
    fireEvent.click(link);
    await waitFor(() => expect([useStore.getState().selectedId, useStore.getState().selectedThreadId]).toEqual(["ws_bench", "thr_bench"]));
  });

  it("leaves the transcript alone on a thread that opened none", async () => {
    const { api } = fixtureApi([workspace], { [WS]: lead });
    await setup(api);
    await screen.findByText("Three workspaces are up.");
    expect(document.querySelectorAll("[data-opened-thread]")).toHaveLength(0);
  });

  it("are totalled beside the turn's own figure in the footer, each figure saying what it counts", async () => {
    const { api } = fixtureApi([workspace, BENCH], { [WS]: lead }, rows);
    await setup(api);
    await screen.findByText("Three workspaces are up.");
    const footer = await waitFor(() => {
      const found = screen.getByTestId("settled-footer");
      expect(found.textContent).toContain("in threads it opened");
      return found;
    });
    expect(footer.textContent).toBe("Worked for 2m 58s $1.14 this turn $2.30 in threads it opened");
    // The facts sit on the reply's row beside its time, in the time's own type.
    expect(footer.className).toContain("text-xs");
    // A narrow window breaks the line between facts, never inside one.
    expect(footer.className).toContain("flex-wrap");
    for (const part of footer.querySelectorAll("span")) {
      if (part.getAttribute("aria-hidden") === "true") continue;
      expect(part.className).toContain("whitespace-nowrap");
    }
  });

  it("a send whose turn dies before it announces itself draws the words above the line that answered them", async () => {
    const settled = settledTurn(WS, "add a health route", "Added GET /health.");
    const { api, emit } = fixtureApi([workspace], { [WS]: settled });
    const handle: { current: ChatThreadHandle | null } = { current: null };
    useStore.getState().bind(api);
    await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
    render(<ChatView workspaceId={WS}>{thread => { handle.current = thread; return null; }}</ChatView>);
    await screen.findByText("Added GET /health.");
    sendFrom(handle.current, "have another look");
    await screen.findByText("have another look");
    // The harness launched, answered nothing and exited: a reply and a plain end, under a turn no start opened. The
    // words this view stood in with are already on screen, so the line lands above them unless the row is placed.
    const dead = { workspaceId: WS, sessionId: `sess_${WS}`, turnId: "turn_dead" };
    emit({ type: "session.done", ...dead, at: T0 + 120_000, result: { status: "failed", error: "claude answered with no output and no usage after 48ms", durationMs: 48, costUsd: 0 } });
    emit({ type: "session.end", ...dead, at: T0 + 120_050, exitCode: 1, sawResult: true });
    // The row draws the sentence with its first letter raised, as the shipped runtime error rows do.
    const line = await screen.findByText(/answered with no output and no usage after 48ms/i);
    const words = screen.getByText("have another look");
    const rows = [...document.querySelectorAll("[data-timeline-row-id]")];
    const at = (node: Element) => rows.findIndex(row => row.contains(node));
    expect(at(words)).toBeGreaterThanOrEqual(0);
    expect(at(words)).toBe(at(line) - 1);
    expect(screen.getAllByText("have another look")).toHaveLength(1);
  });

  it("says nothing about a total on a thread that opened none, and leaves its own figure unqualified", async () => {
    const { api } = fixtureApi([workspace], { [WS]: lead });
    await setup(api);
    await screen.findByText("Three workspaces are up.");
    const footer = screen.getByTestId("settled-footer");
    expect(footer.textContent).toBe("Worked for 2m 58s $1.14");
    expect(footer.textContent).not.toContain("in threads it opened");
    expect(footer.textContent).not.toContain("this turn");
  });
});
