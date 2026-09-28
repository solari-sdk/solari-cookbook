// SPDX-License-Identifier: AGPL-3.0-only
// The runtime client and store against a real in-process serveRuntime through
// the runtime suite's tcp proxy: a cut socket is what a wsp restart looks like
// from an open tab. jsdom's WebSocket is the browser one here.
import { createRuntime, memoryStore, serveRuntime, type HarnessAdapterFactory, type Runtime, type RuntimeServer } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { makeApi, ProtocolClient, type ConnStatus, type ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { createOn, stubBackend } from "../../../packages/runtime/test/stub-backend.js";
import { startTcpProxy, type TcpProxy } from "../../../packages/runtime/test/tcp-proxy.js";
import { clearNotices } from "./notice-text.js";

const TOKEN = "runtime-token";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 25));
  }
}

let srv: RuntimeServer | undefined;
let proxy: TcpProxy | undefined;
let client: ProtocolClient | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  await proxy?.close();
  proxy = undefined;
  await srv?.close();
  srv = undefined;
});

describe("runtime socket reconnect", () => {
  it("a cut socket comes back: re-auth, events restored, list and statuses refetched, conn settles live", async () => {
    const rt: Runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    srv = await serveRuntime(rt, { port: 0, authToken: TOKEN });
    proxy = await startTcpProxy(srv.port);
    useStore.setState({ api: null, conn: "connecting", workspaces: [], statuses: {}, sessions: {}, selectedId: null, ready: false, gaps: 0 });
    clearNotices();

    const statuses: ConnStatus[] = [];
    client = new ProtocolClient({
      url: `ws://127.0.0.1:${proxy.port}`,
      token: TOKEN,
      onStatus: s => {
        statuses.push(s);
        useStore.getState().setConn(s);
      },
      backoffMs: () => 400,
    });
    const events: ProtocolEvent[] = [];
    client.subscribe(e => events.push(e));
    await client.connect();
    useStore.getState().bind(makeApi(client));
    await until(() => useStore.getState().ready);
    expect(useStore.getState().conn).toBe("live");

    proxy.cutAll();
    await until(() => useStore.getState().conn === "reconnecting");
    // Made while the tab was dark: the event reaches this tab only through replay on the next subscribe.
    const dark = await createOn(rt, { golden: "snap_g", name: "made-in-the-dark" });
    expect(events.some(e => e.type === "workspace.created")).toBe(false);

    await until(() => useStore.getState().conn === "live");
    await until(() => useStore.getState().workspaces.some(w => w.id === dark.id));
    await until(() => useStore.getState().statuses[dark.id] !== undefined);

    const lit = await createOn(rt, { golden: "snap_g", name: "after" });
    await until(() => events.some(e => e.type === "workspace.created" && e.workspace.id === lit.id));
    expect(statuses).toEqual(["live", "reconnecting", "live"]);

    const created = events.filter(e => e.type === "workspace.created").map(e => e.workspace.name);
    expect(created).toEqual(["made-in-the-dark", "after"]);
    expect(events.map(e => e.seq)).toEqual([...events.map(e => e.seq)].sort((a, b) => a! - b!));
    expect(useStore.getState().gaps).toBe(0);
  }, 15_000);

  it("a drop longer than the runtime's replay ring comes back as a gap the store counts, and history still holds the turn's end", async () => {
    let onEvent: ((e: { type: "turn.delta"; sessionId: string; kind: "text"; text: string }) => void) | undefined;
    const sessionId = "88888888-8888-4888-8888-888888888888";
    const claude: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        onEvent = o.onEvent;
        o.onEvent({ type: "session.start", sessionId });
        return { localId: sessionId, claudeSessionId: sessionId, finished: new Promise(() => {}), interrupt: async () => {} };
      },
    });
    const rt: Runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude } });
    srv = await serveRuntime(rt, { port: 0, authToken: TOKEN });
    proxy = await startTcpProxy(srv.port);
    useStore.setState({ api: null, conn: "connecting", workspaces: [], statuses: {}, sessions: {}, selectedId: null, ready: false, gaps: 0 });
    clearNotices();
    client = new ProtocolClient({
      url: `ws://127.0.0.1:${proxy.port}`,
      token: TOKEN,
      onStatus: s => useStore.getState().setConn(s),
      onGap: () => useStore.getState().noteGap(),
      backoffMs: () => 400,
    });
    const events: ProtocolEvent[] = [];
    client.subscribe(e => events.push(e));
    await client.connect();
    useStore.getState().bind(makeApi(client));
    await until(() => useStore.getState().ready);
    const ws = await createOn(rt, { golden: "snap_g", name: "chatty" });
    await rt.sessions.start(ws.id, { prompt: "go" });
    await until(() => events.some(e => e.type === "session.start"));

    proxy.cutAll();
    await until(() => useStore.getState().conn === "reconnecting");
    for (let i = 1; i <= 5001; i++) onEvent!({ type: "turn.delta", sessionId, kind: "text", text: `d${i}` });

    await until(() => useStore.getState().conn === "live");
    await until(() => useStore.getState().gaps === 1);
    expect(events.filter(e => e.type === "session.delta")).toEqual([]);
    const history = await useStore.getState().api!.sessionHistory(ws.id);
    expect(history[history.length - 1]).toMatchObject({ type: "session.delta", text: "d5001" });
  }, 15_000);

  it("a wsp restart between the drop and the redial is a gap: the tab refetches and replays nothing from the new process", async () => {
    const store = memoryStore();
    const rtA: Runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    srv = await serveRuntime(rtA, { port: 0, authToken: TOKEN });
    const port = srv.port;
    proxy = await startTcpProxy(port);
    useStore.setState({ api: null, conn: "connecting", workspaces: [], statuses: {}, sessions: {}, selectedId: null, ready: false, gaps: 0 });
    clearNotices();
    client = new ProtocolClient({
      url: `ws://127.0.0.1:${proxy.port}`,
      token: TOKEN,
      onStatus: s => useStore.getState().setConn(s),
      onGap: () => useStore.getState().noteGap(),
      backoffMs: () => 400,
    });
    const events: ProtocolEvent[] = [];
    client.subscribe(e => events.push(e));
    await client.connect();
    useStore.getState().bind(makeApi(client));
    await until(() => useStore.getState().ready);
    await createOn(rtA, { golden: "snap_g", name: "before" });
    await until(() => events.some(e => e.type === "workspace.created"));

    await srv.close();
    await until(() => useStore.getState().conn === "reconnecting");
    const rtB: Runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    srv = await serveRuntime(rtB, { port, authToken: TOKEN });
    // The new process is already past the old cursor when the tab comes back.
    const unseen = await createOn(rtB, { golden: "snap_g", name: "unseen" });
    const later = await createOn(rtB, { golden: "snap_g", name: "later" });

    await until(() => useStore.getState().conn === "live");
    await until(() => useStore.getState().gaps === 1);
    const lit = await createOn(rtB, { golden: "snap_g", name: "after-restart" });
    await until(() => events.some(e => e.type === "workspace.created" && e.workspace.id === lit.id));
    expect(events.filter(e => e.type === "workspace.created").map(e => e.workspace.name)).toEqual(["before", "after-restart"]);
    // The store still converges: the reconnect pulls the list.
    await until(() => [unseen.id, later.id].every(id => useStore.getState().workspaces.some(w => w.id === id)));
  }, 15_000);
});
