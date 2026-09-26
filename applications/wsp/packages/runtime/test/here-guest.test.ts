// SPDX-License-Identifier: AGPL-3.0-only
// The guest session the wsp command's forwarder on this computer opens on the
// host's own socket: who may open one, what the kind's module is handed, how
// its messages ride each way, and that the socket going ends it.
import { guestNoKindLine, guestNoSessionLine, guestSessionHeldLine, hereGuestRefusal, threadOpRefusal } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, serveRuntime, type GuestKindModule, type GuestOpening, type Runtime, type RuntimeServer } from "../src/index.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { WsClient } from "./ws-client.js";

/** A kind's module that records what it was handed and what reached it, and hands the case the opening. */
function recorder() {
  const opened: GuestOpening[] = [];
  const messages: unknown[] = [];
  let closed = 0;
  const here: GuestKindModule = {
    open(o) {
      opened.push(o);
      return { message: m => void messages.push(m), close: () => void closed++ };
    },
  };
  return {
    here,
    opened,
    messages,
    get closed() {
      return closed;
    },
  };
}

const OPEN = { kind: "mcp", token: "", argv: ["mcp", "--state", "/s/state.json"], cwd: "/work", env: { EDITOR: "vi", WSP_TURN: "from-env" } };

describe("a guest session on the host's own socket", () => {
  let rt: Runtime;
  let srv: RuntimeServer | undefined;
  const clients: WsClient[] = [];
  const connect = async (token: string): Promise<WsClient> => {
    const c = await WsClient.connect(srv!.port, { token });
    clients.push(c);
    return c;
  };
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await srv?.close();
    srv = undefined;
  });

  it("opens the tool server for the host's own token and carries its messages each way until the module ends it", async () => {
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const seen = recorder();
    srv = await serveRuntime(rt, { port: 0, authToken: "t", here: seen.here });
    const c = await connect("t");
    expect(await c.request("guest.open", { ...OPEN, turnToken: "turn-1" })).toEqual({ id: 2, ok: true, session: "here" });
    expect(seen.opened).toHaveLength(1);
    const o = seen.opened[0]!;
    expect({ argv: o.argv, cwd: o.cwd, env: o.env }).toEqual({ argv: OPEN.argv, cwd: "/work", env: { EDITOR: "vi", WSP_TURN: "turn-1" } });

    expect(await c.request("guest.send", { message: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).toMatchObject({ ok: true });
    expect(seen.messages).toEqual([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);

    o.reply({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    await expect.poll(() => c.events.find(e => e.type === "guest.message")).toEqual({ type: "guest.message", message: { jsonrpc: "2.0", id: 1, result: { tools: [] } } });

    o.close("the host is stopping");
    await expect.poll(() => c.events.find(e => e.type === "guest.closed")).toEqual({ type: "guest.closed", error: "the host is stopping" });
    // Nothing more rides a session its module ended, and the socket holds none to send to.
    o.reply({ late: true });
    expect(await c.request("guest.send", { message: {} })).toMatchObject({ ok: false, error: guestNoSessionLine });
    expect(c.events.filter(e => e.type === "guest.message")).toHaveLength(1);
  });

  it("ends the session when the socket goes", async () => {
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const seen = recorder();
    srv = await serveRuntime(rt, { port: 0, authToken: "t", here: seen.here });
    const c = await connect("t");
    expect((await c.request("guest.open", OPEN)).ok).toBe(true);
    c.close();
    await expect.poll(() => seen.closed).toBe(1);
  });

  it("refuses a thread's token, a relayed socket, a second session, a kind other than the tool server, and a runtime that serves none", async () => {
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const seen = recorder();
    srv = await serveRuntime(rt, { port: 0, authToken: "t", here: seen.here, devices: rt.devices });

    const thread = (await rt.devices.mint("thread t1", { kind: "thread", threadId: "t1", workspaceId: "w1", rootThreadId: "t1" }, Date.now())).deviceToken;
    expect(await (await connect(thread)).request("guest.open", OPEN)).toMatchObject({ ok: false, error: threadOpRefusal("guest.open", "t1") });

    const owner = await connect("t");
    const { ticket } = (await owner.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    const relayed = await WsClient.connect(srv.port, { ticket });
    clients.push(relayed);
    expect(await relayed.request("guest.open", OPEN)).toMatchObject({ ok: false, error: hereGuestRefusal, kind: "auth" });

    expect(await owner.request("guest.send", { message: {} })).toMatchObject({ ok: false, error: guestNoSessionLine });
    expect(await owner.request("guest.open", { ...OPEN, kind: "cli" })).toMatchObject({ ok: false, error: guestNoKindLine("cli") });
    expect((await owner.request("guest.open", OPEN)).ok).toBe(true);
    expect(await owner.request("guest.open", OPEN)).toMatchObject({ ok: false, error: guestSessionHeldLine });
    expect(seen.opened).toHaveLength(1);

    await srv.close();
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await (await connect("t")).request("guest.open", OPEN)).toMatchObject({ ok: false, error: guestNoKindLine("mcp") });
    // What stands behind the door never changes what a socket that may not open one is told.
    const { ticket: again } = (await (await connect("t")).request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    const bare = await WsClient.connect(srv.port, { ticket: again });
    clients.push(bare);
    expect(await bare.request("guest.open", OPEN)).toMatchObject({ ok: false, error: hereGuestRefusal, kind: "auth" });
  });
});
