// SPDX-License-Identifier: AGPL-3.0-only
// A streaming turn must not re-render the settled part of the thread on every
// chunk. Markdown is where a re-render costs the most, so it is the probe:
// the copied component is replaced with a counter per message text.
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EventUnion, SessionEvent, WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { ChatView } from "../src/components/chat/ChatView.js";
import { CHAT_T0, CHAT_WS } from "./fixtures/chat-stream.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const renders = new Map<string, number>();
vi.mock("../src/components/ChatMarkdown.js", () => ({
  default: ({ text }: { text: string }) => {
    renders.set(text, (renders.get(text) ?? 0) + 1);
    return <div data-markdown>{text}</div>;
  },
}));

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());

const workspace: WorkspaceView = { id: CHAT_WS, name: "api", machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };

const settledTurn = (n: number): SessionEvent[] => {
  const sc = { workspaceId: CHAT_WS, sessionId: "sess_h", turnId: `turn_h_${n}` };
  const start = CHAT_T0 + n * 60_000;
  return [
    { type: "session.start", ...sc, at: start, model: "claude-sonnet-4-5", prompt: `prompt ${n}` },
    { type: "session.delta", ...sc, at: start + 300, kind: "text", text: `answer ${n}` },
    { type: "session.done", ...sc, at: start + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
    { type: "session.end", ...sc, at: start + 950, exitCode: 0, sawResult: true },
  ];
};

function fixtureApi(history: SessionEvent[]) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => history,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [workspace],
    getWorkspace: async () => workspace,
    createWorkspace: async () => workspace,
    nap: async () => workspace,
    wake: async () => workspace,
    capabilities: async () => (caps()),
    listSessions: async () => [],
    watchStatuses: async () => [],
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => ({ id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running" }),
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, emit };
}

describe("streaming a turn", () => {
  it("re-renders only the streaming message, never the settled ones, per text chunk", async () => {
    const { api, emit } = fixtureApi([...settledTurn(1), ...settledTurn(2)]);
    useStore.getState().bind(api);
    await waitFor(() => expect(useStore.getState().workspaces.length).toBe(1));
    render(<ChatView workspaceId={CHAT_WS} />);
    await screen.findByText("answer 2");
    expect(screen.getByText("answer 1")).toBeDefined();

    const live = { workspaceId: CHAT_WS, sessionId: "sess_live", turnId: "turn_live" };
    const t = CHAT_T0 + 600_000;
    emit({ type: "session.start", ...live, at: t, model: "claude-sonnet-4-5", prompt: "stream one" });
    emit({ type: "session.delta", ...live, at: t + 100, kind: "text", text: "chunk" });
    await screen.findByText("chunk");
    const settledBefore = [renders.get("answer 1"), renders.get("answer 2"), renders.get("prompt 1"), renders.get("prompt 2")];
    expect(settledBefore.every(n => typeof n === "number" && n > 0)).toBe(true);

    let text = "chunk";
    for (let i = 1; i <= 8; i += 1) {
      text += ` ${i}`;
      emit({ type: "session.delta", ...live, at: t + 100 + i * 50, kind: "text", text: ` ${i}` });
    }
    await screen.findByText(text);
    expect(renders.get(text)).toBe(1);
    expect([renders.get("answer 1"), renders.get("answer 2"), renders.get("prompt 1"), renders.get("prompt 2")]).toEqual(settledBefore);
  });
});
