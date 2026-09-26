// SPDX-License-Identifier: AGPL-3.0-only
// The composer's stop button over the real client and a scripted runtime
// socket: which frame a click sends, and how the composer reads each
// interrupt outcome together with the events the runtime pushes ahead of the
// reply. The runtime keys sessions.interrupt by its own session id; the
// transcript's events carry the harness id, so the row from sessions.list is
// what maps one to the other.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventUnion, SessionView, WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { TABLE_CATALOG } from "./agents.js";
import { composerEditor, isEditable } from "./composer-harness.js";
import { ScriptedSocket, type Frame } from "./scripted-socket.js";
import { makeApi, ProtocolClient } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { ChatComposer } from "../src/components/chat/ChatComposer.js";
import { ChatView } from "../src/components/chat/ChatView.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { CHAT_TURN, CHAT_WS } from "./fixtures/chat-stream.js";
import { caps } from "./caps.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());

const WS = CHAT_WS;
const CLAUDE_SESSION = "e16ed170-8257-4668-879e-fe836341633c";
const scope = { workspaceId: WS, sessionId: CLAUDE_SESSION, turnId: CHAT_TURN };
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: CLAUDE_SESSION,
};
/** The runtime's row for the running turn: its own id, which sessions.interrupt takes, beside the harness id the events carry. */
const runningRow: SessionView = { id: "sess_local_1", workspaceId: WS, harness: "claude", status: "running", claudeSessionId: CLAUDE_SESSION, prompt: "go", startedAt: 0 };
const CAPS = caps();

let rows: SessionView[] = [];
let onInterrupt: (frame: Frame) => Frame | undefined = () => undefined;
let client: ProtocolClient | null = null;

function route(frame: Frame): Frame | undefined {
  const id = frame["id"];
  switch (frame["op"]) {
    case "events.subscribe": return { id, ok: true, seq: 0, stream: "stream-a" };
    case "workspaces.list": return { id, ok: true, workspaces: [workspace] };
    case "sessions.list": return { id, ok: true, sessions: rows };
    case "status.subscribe": return { id, ok: true, statuses: [] };
    case "capabilities.get": return { id, ok: true, capabilities: CAPS };
    case "forwards.list": return { id, ok: true, forwards: [] };
    case "sessions.history": return { id, ok: true, events: [] };
    case "sessions.interrupt": return onInterrupt(frame);
    default: return { id, ok: false, error: `unscripted op ${String(frame["op"])}` };
  }
}

beforeEach(() => {
  rows = [];
  onInterrupt = () => undefined;
  ScriptedSocket.authOk = true;
  ScriptedSocket.serverUp = true;
  ScriptedSocket.reply = route;
  useComposerDraftStore.setState({ drafts: {}, queues: {} });
});
afterEach(() => { client?.close(); client = null; });

async function setup() {
  ScriptedSocket.instances.length = 0;
  client = new ProtocolClient({ url: "ws://test", token: "tok", WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket });
  await client.connect();
  const sock = ScriptedSocket.instances[0]!;
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, sessions: {} });
  useStore.getState().bind(makeApi(client));
  useStore.getState().setConn("live");
  useStore.setState({ harnesses: [TABLE_CATALOG] });
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  render(<ChatView workspaceId={WS}>{thread => <ChatComposer workspaceId={WS} thread={thread} />}</ChatView>);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  /** A frame from the runtime, delivered where the caller already is (inside a click, or inside act). */
  const deliver = (e: Record<string, unknown>) => sock.onmessage?.({ data: JSON.stringify(e) });
  const push = (e: EventUnion) => act(() => deliver(e));
  return { sock, deliver, push };
}

/** One turn streaming, with the runtime's row for it listed unless the test cleared rows. */
async function streamTurn(push: (e: EventUnion) => void) {
  push({ type: "session.start", ...scope, prompt: "go" });
  push({ type: "session.delta", ...scope, kind: "text", text: "on it" });
  await waitFor(() => expect(useStore.getState().sessions[WS]?.length ?? 0).toBe(rows.length));
  await screen.findByRole("button", { name: "Stop generation" });
}

const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
const stopButton = () => screen.getByRole("button", { name: "Stop generation" }) as HTMLButtonElement;
const sendButton = () => screen.getByRole("button", { name: /Send message|Turn in flight/ }) as HTMLButtonElement;
const footer = () => screen.getByTestId("settled-footer").textContent ?? "";
const done = (status: "completed" | "interrupted"): EventUnion => ({ type: "session.done", ...scope, result: { status, durationMs: 1200 } });
const end: EventUnion = { type: "session.end", ...scope, exitCode: 0, sawResult: true };

describe("composer stop", () => {
  it("stop mid-turn sends one sessions.interrupt for the runtime's session; the composer opens when the interrupted turn ends", async () => {
    rows = [runningRow];
    const { sock, deliver, push } = await setup();
    await streamTurn(push);
    expect(screen.queryByRole("status")).toBeNull();
    // The runtime answers accepted only after the turn's done and end are on the wire.
    onInterrupt = f => {
      deliver(done("interrupted"));
      deliver(end);
      return { id: f["id"], ok: true, outcome: "accepted" };
    };
    fireEvent.click(stopButton());
    expect(sock.frames("sessions.interrupt")).toEqual([{ id: expect.any(Number), op: "sessions.interrupt", sessionId: runningRow.id }]);
    await waitFor(() => expect(footer()).toContain("interrupted"));
    await settle();
    expect(screen.queryByRole("button", { name: /Stop generation|Stopping/ })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
    expect(isEditable(composerEditor())).toBe(true);
    expect(sock.frames("sessions.interrupt")).toHaveLength(1);
  });

  it("stop after the turn ended is a no-op: not-running shows no error", async () => {
    rows = [runningRow];
    const { sock, deliver, push } = await setup();
    await streamTurn(push);
    onInterrupt = f => {
      deliver(done("completed"));
      deliver(end);
      return { id: f["id"], ok: true, outcome: "not-running" };
    };
    fireEvent.click(stopButton());
    expect(sock.frames("sessions.interrupt")).toHaveLength(1);
    await waitFor(() => expect(footer()).toContain("Worked for"));
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop generation|Stopping/ })).toBeNull();
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
  });

  it("a double click sends one request; the button stays disabled as Stopping until the reply", async () => {
    rows = [runningRow];
    const { sock, deliver, push } = await setup();
    await streamTurn(push);
    let held: Frame | null = null;
    onInterrupt = f => { held = f; return undefined; };
    fireEvent.click(stopButton());
    const pending = screen.getByRole("button", { name: "Stopping" }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    await settle();
    expect(sock.frames("sessions.interrupt")).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Stopping" }) as HTMLButtonElement).disabled).toBe(true);
    expect(held).not.toBeNull();
    act(() => {
      deliver(done("interrupted"));
      deliver(end);
      deliver({ id: held!["id"], ok: true, outcome: "accepted" });
    });
    await waitFor(() => expect(footer()).toContain("interrupted"));
    expect(screen.queryByRole("button", { name: /Stop generation|Stopping/ })).toBeNull();
    expect(sock.frames("sessions.interrupt")).toHaveLength(1);
  });

  it("not-found shows the reason in the status row and offers stop again; a refused request shows its message; the turn's end clears it", async () => {
    // No row for the turn: the composer falls back to the id the events carry, which the runtime does not key.
    rows = [];
    const { sock, push } = await setup();
    await streamTurn(push);
    onInterrupt = f => ({ id: f["id"], ok: true, outcome: "not-found" });
    fireEvent.click(stopButton());
    expect(sock.frames("sessions.interrupt")).toEqual([{ id: expect.any(Number), op: "sessions.interrupt", sessionId: CLAUDE_SESSION }]);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Could not stop: the runtime does not know this session"));
    expect(stopButton().disabled).toBe(false);
    onInterrupt = f => ({ id: f["id"], ok: false, error: "runtime is busy" });
    fireEvent.click(stopButton());
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Could not stop: runtime is busy"));
    expect(sock.frames("sessions.interrupt")).toHaveLength(2);
    push(done("completed"));
    push(end);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
  });
});
