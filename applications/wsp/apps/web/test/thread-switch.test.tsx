// SPDX-License-Identifier: AGPL-3.0-only
// Switching threads in the sidebar while a turn runs in another thread of the
// same workspace: the click selects the thread, the center shows that thread,
// the running turn keeps its row and its progress, and switching back shows
// what streamed meanwhile.
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventUnion, GoldenManifest, SessionEvent, SessionView, WorkspaceView } from "@wsp/protocol";
import { Shell } from "../src/App.js";
import type { Api, ProtocolEvent, StartSessionOptions } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { press, typeInto } from "./composer-harness.js";
import { installFakeLayout } from "./fake-layout.js";
import { TABLE_CATALOG, whenAgentsAnswered } from "./agents.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices } from "./notice-text.js";

const WS = "ws_switch";
// An hour before the run, not a fixed date: these rows must stay on the idle shelf, and a fixed date walks past the
// archive threshold as soon as the calendar moves, which shuts them into the archive and hides them from the sidebar.
const T0 = Date.now() - 60 * 60_000;
const workspace: WorkspaceView = { id: WS, name: "api", machineId: "m_api", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z", claudeSessionId: "sess_b" };
const manifest: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "default", kind: "sandbox", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }],
};

const A = { workspaceId: WS, sessionId: "sess_a", turnId: "turn_a", threadId: "thr_a" };
const B = { workspaceId: WS, sessionId: "sess_b", turnId: "turn_b", threadId: "thr_b" };
const SETTLED_A: SessionEvent[] = [
  { type: "session.start", ...A, at: T0, prompt: "make me a simple server" },
  { type: "session.delta", ...A, at: T0 + 300, kind: "text", text: "Added GET /health." },
  { type: "session.done", ...A, at: T0 + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
  { type: "session.end", ...A, at: T0 + 950, exitCode: 0, sawResult: true },
];
const RUNNING_B: SessionEvent[] = [
  { type: "session.start", ...B, at: T0 + 60_000, prompt: "do you have access" },
  { type: "session.delta", ...B, at: T0 + 60_300, kind: "text", text: "Checking the keychain." },
];
const ROWS: SessionView[] = [
  { id: "s_a", workspaceId: WS, harness: "claude", status: "completed", prompt: "make me a simple server", startedAt: T0, endedAt: T0 + 950, threadId: "thr_a" },
  { id: "s_b", workspaceId: WS, harness: "claude", status: "running", prompt: "do you have access", startedAt: T0 + 60_000, threadId: "thr_b" },
];

/** The runtime records an event before it pushes it, so a later history reply holds everything emitted so far. */
function fixtureApi(transcript: SessionEvent[] = [...SETTLED_A, ...RUNNING_B], rows: SessionView[] = ROWS, ws: WorkspaceView = workspace) {
  const history: SessionEvent[] = [...transcript];
  const started: StartSessionOptions[] = [];
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
    listWorkspaces: async () => [ws],
    getWorkspace: async () => ws,
    createWorkspace: async () => ws,
    watchStatuses: async () => [],
    nap: async () => workspace,
    wake: async () => workspace,
    capabilities: async () => (caps()),
    startSession: async o => {
      started.push(o);
      return { id: "s_x", workspaceId: o.workspaceId, harness: "claude", status: "running" };
    },
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [...history],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => rows,
    listHarnesses: async () => [TABLE_CATALOG],
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => manifest,
  };
  const emit = (e: SessionEvent) => {
    // Once the next case has bound its own api, this case's events have no tree to land in.
    if (useStore.getState().api !== api) return;
    history.push(e);
    act(() => { for (const fn of [...listeners]) fn(e as EventUnion); });
  };
  return { api, emit, started };
}

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false, gaps: 0 });
  clearNotices();
});
afterEach(() => cleanup());

/** Queries bound to one case's Shell: a case that outlives its budget keeps running, and must not reach the next case's tree. */
function shellOf(container: HTMLElement) {
  const shell = within(container);
  const sidebar = () => within(container.querySelector<HTMLElement>("[data-app-sidebar]")!);
  const center = () => within(container.querySelector<HTMLElement>("[data-shell-center]")!);
  const threadRow = (title: string): HTMLElement => sidebar().getByText(title).closest<HTMLElement>("[data-sidebar-row]")!;
  const editor = () => shell.getByTestId("composer-editor");
  return { shell, sidebar, center, threadRow, editor };
}

async function mount(fixture = fixtureApi(), latest = "Checking the keychain.") {
  useStore.getState().bind(fixture.api);
  await whenAgentsAnswered();
  const { container } = render(<Shell />);
  const view = shellOf(container);
  // The first paint is polled for: a stale case's open act scope can hold this render's work until it closes.
  await waitFor(() => expect(view.center().getByText(latest)).toBeDefined());
  await waitFor(() => expect(view.sidebar().getByText("make me a simple server")).toBeDefined());
  return { ...fixture, ...view, container };
}

describe("switching between idle threads", () => {
  it("clicking the older thread's row shows it in place of the newest one", async () => {
    const DONE_B: SessionEvent[] = [
      ...RUNNING_B,
      { type: "session.done", ...B, at: T0 + 61_000, result: { status: "completed", durationMs: 1_000, costUsd: 0.002 } },
      { type: "session.end", ...B, at: T0 + 61_100, exitCode: 0, sawResult: true },
    ];
    const rows: SessionView[] = [ROWS[0]!, { ...ROWS[1]!, status: "completed", endedAt: T0 + 61_100 }];
    const { center, threadRow } = await mount(fixtureApi([...SETTLED_A, ...DONE_B], rows));
    expect(center().queryByText("Added GET /health.")).toBeNull();
    fireEvent.click(threadRow("make me a simple server"));
    await center().findByText("Added GET /health.");
    expect(center().queryByText("Checking the keychain.")).toBeNull();
    fireEvent.click(threadRow("do you have access"));
    await center().findByText("Checking the keychain.");
    expect(center().queryByText("Added GET /health.")).toBeNull();
  });
});

describe("the header and the body through a settle", () => {
  it("the header names the thread the body shows, not the newest row, and the address records it", async () => {
    const A2 = { ...A, turnId: "turn_a2" };
    // The transcript ends in the older thread's new turn while the rows still end in the other thread: the two
    // readings of "the latest" disagree, which is what put one thread's name over another's transcript.
    const transcript: SessionEvent[] = [
      ...SETTLED_A,
      ...RUNNING_B,
      { type: "session.start", ...A2, at: T0 + 90_000, prompt: "add a readiness route too" },
      { type: "session.delta", ...A2, at: T0 + 90_300, kind: "text", text: "Adding GET /ready." },
    ];
    const { center, container } = await mount(fixtureApi(transcript, ROWS), "Adding GET /ready.");
    const crumb = () => container.querySelector("[data-shell-center] [data-thread-breadcrumb]")!.textContent;
    await waitFor(() => expect(crumb()).toBe("api/make me a simple server"));
    expect(center().queryByText("Checking the keychain.")).toBeNull();
    expect(useStore.getState().selectedThreadId).toBe("thr_a");
    expect(window.location.hash).toBe(`#w/${WS}/t/thr_a`);
  });
});

describe("a new thread's address", () => {
  it("the screen it is written on has one, and its first turn takes the thread's own", async () => {
    const { emit, started, center, editor, shell } = await mount();
    fireEvent.click(shell.getByRole("button", { name: "New thread" }));
    await waitFor(() => expect(center().getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?"));
    expect(window.location.hash).toBe(`#w/${WS}/new`);
    emit({ type: "session.done", ...B, at: T0 + 100_000, result: { status: "completed", durationMs: 40_000, costUsd: 0.002 } });
    emit({ type: "session.end", ...B, at: T0 + 100_100, exitCode: 0, sawResult: true });
    await typeInto(editor(), "third thread");
    await press(editor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    const C = { workspaceId: WS, sessionId: "sess_c", turnId: "turn_c", threadId: "thr_c" };
    emit({ type: "session.start", ...C, at: T0 + 120_000, prompt: "third thread" });
    emit({ type: "session.delta", ...C, at: T0 + 120_300, kind: "text", text: "Third answer." });
    await center().findByText("Third answer.");
    expect(window.location.hash).toBe(`#w/${WS}/t/thr_c`);
    expect(useStore.getState()).toMatchObject({ selectedThreadId: "thr_c", freshThread: false });
  });
});

describe("switching threads while a turn runs", () => {
  it("clicking the idle thread's row selects it and the center shows its transcript and composer", async () => {
    const { center, threadRow } = await mount();
    expect(center().getByText(/Working for/)).toBeDefined();
    fireEvent.click(threadRow("make me a simple server"));
    expect(useStore.getState().selectedId).toBe(WS);
    expect(useStore.getState().selectedThreadId).toBe("thr_a");
    await center().findByText("Added GET /health.");
    expect(center().queryByText("Checking the keychain.")).toBeNull();
    expect(center().queryByText(/Working for/)).toBeNull();
    expect(center().getByTestId("settled-footer").textContent).toContain("Worked for");
    expect(center().getByTestId("composer-editor")).toBeDefined();
    expect(threadRow("make me a simple server").getAttribute("data-active")).toBe("true");
    expect(threadRow("do you have access").getAttribute("data-active")).toBe("false");
  });

  it("the running turn keeps its row in Working and its stream stays out of the shown thread", async () => {
    const { emit, center, threadRow } = await mount();
    fireEvent.click(threadRow("make me a simple server"));
    await center().findByText("Added GET /health.");
    emit({ type: "session.delta", ...B, at: T0 + 61_000, kind: "text", text: " Found it in the keychain." });
    expect(center().queryByText(/Found it in the keychain/)).toBeNull();
    expect(center().queryByText(/Working for/)).toBeNull();
    expect(threadRow("do you have access").querySelector("[data-thread-state]")!.textContent).toBe("Working");
    expect(threadRow("make me a simple server").querySelector("[data-thread-state]")).toBeNull();
  });

  it("switching back shows the progress streamed meanwhile and keeps streaming", async () => {
    const { emit, center, threadRow } = await mount();
    fireEvent.click(threadRow("make me a simple server"));
    await center().findByText("Added GET /health.");
    emit({ type: "session.delta", ...B, at: T0 + 61_000, kind: "text", text: " Found it in the keychain." });
    fireEvent.click(threadRow("do you have access"));
    expect(useStore.getState().selectedThreadId).toBe("thr_b");
    await center().findByText(/Checking the keychain\. Found it in the keychain\./);
    expect(center().queryByText("Added GET /health.")).toBeNull();
    expect(center().getByText(/Working for/)).toBeDefined();
    emit({ type: "session.delta", ...B, at: T0 + 62_000, kind: "text", text: " Reading it now." });
    await center().findByText(/Found it in the keychain\. Reading it now\./);
    expect(threadRow("do you have access").getAttribute("data-active")).toBe("true");
  });

  it("a send from an older thread's view resumes that thread's session, and from the latest view the latest one", async () => {
    const { started, center, threadRow, editor } = await mount();
    fireEvent.click(threadRow("make me a simple server"));
    await center().findByText("Added GET /health.");
    await typeInto(editor(), "add a readiness route too");
    await press(editor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ workspaceId: WS, prompt: "add a readiness route too", resume: "sess_a" });
    await center().findByText("add a readiness route too");
    fireEvent.click(threadRow("do you have access"));
    await center().findByText("Checking the keychain.");
    expect(center().getByRole("button", { name: "Turn in flight" })).toBeDefined();
  });

  it("a send from an older thread makes it the latest; the latest view then keeps the still running thread's deltas out", async () => {
    const { emit, started, center, sidebar, threadRow, editor } = await mount();
    fireEvent.click(threadRow("make me a simple server"));
    await center().findByText("Added GET /health.");
    await typeInto(editor(), "add a readiness route too");
    await press(editor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    const A2 = { ...A, turnId: "turn_a2" };
    emit({ type: "session.start", ...A2, at: T0 + 90_000, prompt: "add a readiness route too" });
    emit({ type: "session.delta", ...A2, at: T0 + 90_300, kind: "text", text: "Adding GET /ready." });
    await center().findByText("Adding GET /ready.");
    fireEvent.click(sidebar().getByText("api").closest<HTMLElement>("[data-sidebar-row]")!);
    expect(useStore.getState()).toMatchObject({ selectedId: WS, selectedThreadId: null });
    expect(threadRow("make me a simple server").getAttribute("data-active")).toBe("false");
    await center().findByText("Adding GET /ready.");
    expect(center().queryByText("Checking the keychain.")).toBeNull();
    emit({ type: "session.delta", ...B, at: T0 + 91_000, kind: "text", text: " Found it in the keychain." });
    expect(center().queryByText(/Found it in the keychain/)).toBeNull();
    emit({ type: "session.delta", ...A2, at: T0 + 91_300, kind: "text", text: " Wiring it in." });
    await center().findByText(/Adding GET \/ready\. Wiring it in\./);
    expect(threadRow("do you have access").querySelector("[data-thread-state]")!.textContent).toBe("Working");
  });

  it("after a reload with two threads running, the latest view shows the last started one and drops the other's deltas", async () => {
    const A2 = { ...A, turnId: "turn_a2" };
    const RUNNING_A2: SessionEvent[] = [
      { type: "session.start", ...A2, at: T0 + 90_000, prompt: "add a readiness route too" },
      { type: "session.delta", ...A2, at: T0 + 90_300, kind: "text", text: "Adding GET /ready." },
    ];
    const rows: SessionView[] = [ROWS[0]!, ROWS[1]!, { id: "s_a2", workspaceId: WS, harness: "claude", status: "running", prompt: "add a readiness route too", startedAt: T0 + 90_000, threadId: "thr_a" }];
    const { emit, center } = await mount(fixtureApi([...SETTLED_A, ...RUNNING_B, ...RUNNING_A2], rows), "Adding GET /ready.");
    expect(center().queryByText("Checking the keychain.")).toBeNull();
    emit({ type: "session.delta", ...B, at: T0 + 91_000, kind: "text", text: " Found it in the keychain." });
    expect(center().queryByText(/Found it in the keychain/)).toBeNull();
    emit({ type: "session.delta", ...A2, at: T0 + 91_300, kind: "text", text: " Wiring it in." });
    await center().findByText(/Adding GET \/ready\. Wiring it in\./);
  });

  it("with two threads running, a send from the latest view resumes the thread it shows, not the one started last", async () => {
    const A2 = { ...A, turnId: "turn_a2" };
    const transcript: SessionEvent[] = [
      ...SETTLED_A,
      ...RUNNING_B,
      { type: "session.start", ...A2, at: T0 + 90_000, prompt: "add a readiness route too" },
      { type: "session.delta", ...A2, at: T0 + 90_300, kind: "text", text: "Adding GET /ready." },
      { type: "session.done", ...B, at: T0 + 91_000, result: { status: "completed", durationMs: 31_000, costUsd: 0.002 } },
      { type: "session.end", ...B, at: T0 + 91_100, exitCode: 0, sawResult: true },
    ];
    const rows: SessionView[] = [
      ROWS[0]!,
      { ...ROWS[1]!, status: "completed", endedAt: T0 + 91_100 },
      { id: "s_a2", workspaceId: WS, harness: "claude", status: "running", prompt: "add a readiness route too", startedAt: T0 + 90_000, threadId: "thr_a" },
    ];
    const { emit, started, center, editor } = await mount(fixtureApi(transcript, rows, { ...workspace, claudeSessionId: "sess_a" }));
    expect(center().queryByText("Adding GET /ready.")).toBeNull();
    expect(center().getByTestId("settled-footer").textContent).toContain("Worked for");
    await typeInto(editor(), "check the login keychain too");
    await press(editor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ prompt: "check the login keychain too", resume: "sess_b" });
    const B2 = { ...B, turnId: "turn_b2" };
    emit({ type: "session.start", ...B2, at: T0 + 120_000, prompt: "check the login keychain too" });
    emit({ type: "session.delta", ...B2, at: T0 + 120_300, kind: "text", text: "Login keychain is unlocked." });
    await center().findByText("Login keychain is unlocked.");
    expect(center().getAllByText("check the login keychain too")).toHaveLength(1);
    expect(center().getByText(/Working for/)).toBeDefined();
    emit({ type: "session.done", ...B2, at: T0 + 121_000, result: { status: "completed", durationMs: 1_000, costUsd: 0.001 } });
    emit({ type: "session.end", ...B2, at: T0 + 121_100, exitCode: 0, sawResult: true });
    await waitFor(() => expect(center().queryByRole("button", { name: "Turn in flight" })).toBeNull());
    expect(center().getByTestId("composer-editor")).toBeDefined();
  });

  it("a new thread asked for while two threads run shows nothing of either until its own session.start", async () => {
    const A2 = { ...A, turnId: "turn_a2" };
    const RUNNING_A2: SessionEvent[] = [
      { type: "session.start", ...A2, at: T0 + 90_000, prompt: "add a readiness route too" },
      { type: "session.delta", ...A2, at: T0 + 90_300, kind: "text", text: "Adding GET /ready." },
    ];
    const rows: SessionView[] = [ROWS[0]!, ROWS[1]!, { id: "s_a2", workspaceId: WS, harness: "claude", status: "running", prompt: "add a readiness route too", startedAt: T0 + 90_000, threadId: "thr_a" }];
    const { emit, started, center, editor, shell } = await mount(fixtureApi([...SETTLED_A, ...RUNNING_B, ...RUNNING_A2], rows), "Adding GET /ready.");
    fireEvent.click(shell.getByRole("button", { name: "New thread" }));
    await waitFor(() => expect(center().getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?"));
    emit({ type: "session.delta", ...B, at: T0 + 91_000, kind: "text", text: " Found it in the keychain." });
    expect(center().queryByText(/Found it in the keychain/)).toBeNull();
    emit({ type: "session.delta", ...A2, at: T0 + 91_300, kind: "text", text: " Wiring it in." });
    expect(center().queryByText(/Wiring it in/)).toBeNull();
    expect(center().getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");
    // The composer opens once the left turn ends; the start that follows the send is the person's own by the prompt it carries.
    emit({ type: "session.done", ...A2, at: T0 + 100_000, result: { status: "completed", durationMs: 10_000, costUsd: 0.002 } });
    emit({ type: "session.end", ...A2, at: T0 + 100_100, exitCode: 0, sawResult: true });
    await typeInto(editor(), "third thread");
    await press(editor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({ workspaceId: WS, prompt: "third thread" });
    expect(started[0]).not.toHaveProperty("resume");
    const C = { workspaceId: WS, sessionId: "sess_c", turnId: "turn_c", threadId: "thr_c" };
    emit({ type: "session.start", ...C, at: T0 + 120_000, prompt: "third thread" });
    emit({ type: "session.delta", ...C, at: T0 + 120_300, kind: "text", text: "Third answer." });
    await center().findByText("Third answer.");
    expect(center().queryByText(/Found it in the keychain/)).toBeNull();
    expect(center().queryByText(/Adding GET \/ready/)).toBeNull();
    emit({ type: "session.delta", ...B, at: T0 + 121_000, kind: "text", text: " Reading it now." });
    expect(center().queryByText(/Reading it now/)).toBeNull();
  });

  it("a new thread asked for from an older thread's view unpins it and opens as the workspace's latest", async () => {
    const { emit, started, center, threadRow, editor, shell } = await mount();
    fireEvent.click(threadRow("make me a simple server"));
    await center().findByText("Added GET /health.");
    fireEvent.click(shell.getByRole("button", { name: "New thread" }));
    expect(useStore.getState()).toMatchObject({ selectedId: WS, selectedThreadId: null });
    await waitFor(() => expect(center().getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?"));
    expect(threadRow("make me a simple server").getAttribute("data-active")).toBe("false");
    emit({ type: "session.done", ...B, at: T0 + 100_000, result: { status: "completed", durationMs: 40_000, costUsd: 0.002 } });
    emit({ type: "session.end", ...B, at: T0 + 100_100, exitCode: 0, sawResult: true });
    await typeInto(editor(), "third thread");
    await press(editor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    const C = { workspaceId: WS, sessionId: "sess_c", turnId: "turn_c", threadId: "thr_c" };
    emit({ type: "session.start", ...C, at: T0 + 120_000, prompt: "third thread" });
    emit({ type: "session.delta", ...C, at: T0 + 120_300, kind: "text", text: "Third answer." });
    await center().findByText("Third answer.");
    expect(center().queryByText("Added GET /health.")).toBeNull();
    expect(center().queryByText("Checking the keychain.")).toBeNull();
  });
});
