// SPDX-License-Identifier: AGPL-3.0-only
// The callback relay on a computer this host holds as a place: its link is the
// channel the runtime holds over that computer's own socket, and a sign-in page
// opened there has its callback port listened on here and carried back over it.
// The computer is a fake whose tunnels reach a fake harness listening on this
// machine's loopback; nothing dials a real box.
import { connect, createServer, type Server, type Socket } from "node:net";
import type { DaemonResponse } from "@wsp/protocol";
import type { CallbackForwards, DaemonChannel, EventUnion, Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { CALLBACK_HOLD_MAX_BYTES, startCallbackRelay, type CallbackRelay } from "../src/relay.js";

const AUTH = (port: number): string => `https://mcp.example.com/authorize?client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A${port}%2Fcallback&state=S`;

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waited ${ms}ms and this never came true: ${cond.toString()}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

/** A harness on the box listening for its one callback: what it was sent, and a page that says it landed. */
async function harness(): Promise<{ server: Server; port: number; heard: string[] }> {
  const heard: string[] = [];
  const server = createServer(c => {
    c.on("data", d => {
      heard.push(d.toString("utf8"));
      c.end("HTTP/1.1 200 OK\r\ncontent-length: 9\r\nconnection: close\r\n\r\nsigned in");
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port, heard };
}

/** One joined computer's link as the runtime's place door hands it out: frames answered here, events pushed at every
 * channel open on it, and a tunnel to the callback port carried to the harness. */
function joinedComputer(callbackPorts: readonly number[], harnessPort: number) {
  const readers = new Set<(e: Record<string, unknown>) => void>();
  const ends = new Set<() => void>();
  const ops: { op: string; frame: Record<string, unknown> }[] = [];
  const tunnels = new Map<string, Socket>();
  const push = (e: Record<string, unknown>): void => {
    for (const read of readers) read(e);
  };
  const answer = async (frame: Record<string, unknown>): Promise<DaemonResponse> => {
    const op = String(frame["op"]);
    ops.push({ op, frame });
    const ok = { id: null, ok: true } as DaemonResponse;
    if (op === "ports.watch") return { ...ok, ports: [] } as DaemonResponse;
    const tunnelId = String(frame["tunnelId"]);
    if (op === "tunnel.open") {
      if (!callbackPorts.includes(frame["port"] as number)) return { id: null, ok: false, error: "nothing listens there" } as DaemonResponse;
      const c = connect({ port: harnessPort, host: "127.0.0.1" });
      tunnels.set(tunnelId, c);
      c.on("data", d => push({ type: "tunnel.data", tunnelId, data: d.toString("base64") }));
      c.on("end", () => push({ type: "tunnel.end", tunnelId }));
      c.on("error", () => {});
      await new Promise<void>(r => c.once("connect", () => r()));
      return ok;
    }
    if (op === "tunnel.write") tunnels.get(tunnelId)?.write(Buffer.from(String(frame["data"]), "base64"));
    if (op === "tunnel.close") tunnels.get(tunnelId)?.destroy();
    return ok;
  };
  const channel = (onEvent: (e: Record<string, unknown>) => void): DaemonChannel => {
    readers.add(onEvent);
    let end: (gone: { code: number; reason: string }) => void = () => {};
    const closed = new Promise<{ code: number; reason: string }>(r => (end = r));
    const gone = (): void => {
      readers.delete(onEvent);
      end({ code: 1006, reason: "link gone" });
    };
    ends.add(gone);
    return { send: answer as DaemonChannel["send"], closed, close: () => (readers.delete(onEvent), ends.delete(gone), end({ code: 1000, reason: "closed here" })) };
  };
  return { ops, push, channel, readers, drop: () => [...ends].forEach(e => e()) };
}

/** A runtime with one joined computer and no workspace, whose backend forwards nothing: a place's link is the host's
 * own, so its callback rides it whatever the provider offers. */
function placeRuntime(box: ReturnType<typeof joinedComputer>) {
  const listeners = new Set<(e: EventUnion) => void>();
  let forwards: CallbackForwards | undefined;
  const rt = {
    events: { on: (_type: string, fn: (e: EventUnion) => void) => (listeners.add(fn), () => listeners.delete(fn)) },
    backend: { capabilities: { callbackRelay: false } },
    workspaces: { list: async () => [] },
    places: {
      list: async () => [
        { id: "here", name: "this Mac", kind: "computer" },
        { id: "pl_1", name: "spoo", kind: "computer" },
      ],
      channel: (_id: string, onEvent: (e: Record<string, unknown>) => void) => box.channel(onEvent),
      nameOf: () => "spoo",
    },
    agents: {
      forwards: (f: CallbackForwards) => {
        forwards = f;
        return () => (forwards = undefined);
      },
    },
  } as unknown as Runtime;
  return { rt, emit: (e: EventUnion) => listeners.forEach(fn => fn(e)), forwards: () => forwards };
}

function get(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect({ port, host: "127.0.0.1" });
    let said = "";
    c.on("data", d => (said += d.toString("utf8")));
    c.on("end", () => resolve(said));
    c.on("error", reject);
    c.once("connect", () => c.write(`GET ${path} HTTP/1.1\r\nhost: localhost:${port}\r\n\r\n`));
  });
}

describe("the callback relay on a joined computer", () => {
  let relay: CallbackRelay | undefined;
  const servers: Server[] = [];
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  });

  async function setup(h?: Awaited<ReturnType<typeof harness>>) {
    h ??= await harness();
    servers.push(h.server);
    const port = await freePort();
    const second = await freePort();
    const box = joinedComputer([port, second], h.port);
    const { rt, emit, forwards } = placeRuntime(box);
    const lines: string[] = [];
    const guestEvents: string[] = [];
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async () => true,
      log: l => void lines.push(l),
      places: true,
      listenHosts: ["127.0.0.1"],
      guest: { event: (_l: unknown, e: { type: string }) => void guestEvents.push(e.type), closeAll: () => {} } as never,
    });
    await until(() => box.ops.some(o => o.op === "ports.watch"));
    return { h, port, second, box, emit, forwards, lines, guestEvents };
  }

  it("listens on this computer for the port a page opened there names and carries the one callback to the harness there, logging no address", async () => {
    const { h, port, box, forwards, lines } = await setup();
    forwards()!.open({ placeId: "pl_1" });
    box.push({ type: "browser.open", url: AUTH(port), port });
    await until(() => relay!.list().some(f => f.port === port));
    expect(relay!.list()).toEqual([expect.objectContaining({ workspaceId: "pl_1", port, kind: "callback", name: "spoo" })]);
    const page = await get(port, "/callback?code=THECODE&state=S");
    expect(page).toContain("signed in");
    expect(h.heard.join("")).toContain("GET /callback?code=THECODE&state=S");
    expect(lines.some(l => l.includes(`forwarding localhost:${port} on this computer to the computer for the sign-in callback`))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/THECODE|state=S|redirect_uri/);
  });

  it("holds nothing of that computer's workspaces: no guest watch, no guest session, no printed local URL forwarded", async () => {
    const { box, guestEvents } = await setup();
    const other = await freePort();
    box.push({ type: "guest.opened", session: "g1", life: "life-1", kind: "cli", token: "dev-1.tok", argv: ["threads"], cwd: "/root", machineId: "k1" });
    box.push({ type: "localhost.url", port: other });
    await new Promise(r => setTimeout(r, 50));
    expect(box.ops.map(o => o.op)).not.toContain("guest.watch");
    expect(guestEvents).toEqual([]);
    expect(relay!.list()).toEqual([]);
  });

  it("arms a sign-in's forward from the page it saw, says when this computer cannot listen, and carries a landed address to that port alone", async () => {
    const { h, port, box, forwards } = await setup();
    expect(forwards()?.reaches({ placeId: "pl_2" })).toBe(false);
    expect(forwards()?.open({ placeId: "pl_2" })).toBeUndefined();
    expect(forwards()?.reaches({ placeId: "pl_1" })).toBe(true);
    const forward = forwards()!.open({ placeId: "pl_1" })!;
    expect(await forward.arm("https://mcp.example.com/authorize?client_id=c")).toBe(false);
    expect(await forward.arm(AUTH(port))).toBe(true);
    expect(relay!.list().map(f => f.port)).toEqual([port]);
    await forward.deliver(`http://localhost:${port}/callback?code=PASTED&state=S`);
    expect(h.heard.join("")).toContain("GET /callback?code=PASTED&state=S HTTP/1.1");
    await expect(forward.deliver(`http://localhost:${port + 1}/callback?code=x`)).rejects.toThrow(/not the port/);
    await expect(forward.deliver(`http://evil.example.com:${port}/callback?code=x`)).rejects.toThrow(/not an address on/);
    // A port this computer already uses is one it cannot forward: the sign-in is told so and takes the landed address.
    relay!.stop("pl_1", port);
    const taken = createServer();
    servers.push(taken);
    await new Promise<void>(r => taken.listen(port, "127.0.0.1", r));
    expect(await forward.arm(AUTH(port))).toBe(false);
    const before = h.heard.length;
    await forward.deliver(`http://127.0.0.1:${port}/callback?code=AGAIN`);
    expect(h.heard.length).toBe(before + 1);
    expect(box.ops.filter(o => o.op === "tunnel.open").every(o => o.frame["port"] === port)).toBe(true);
  });

  it("closes a computer's forward when the computer is removed, and holds a callback across its link's gap", async () => {
    const { port, box, emit, forwards } = await setup();
    forwards()!.open({ placeId: "pl_1" });
    box.push({ type: "browser.open", url: AUTH(port), port });
    await until(() => relay!.list().length === 1);
    box.drop();
    const landed = get(port, "/callback?code=HELD");
    await new Promise(r => setTimeout(r, 30));
    emit({ type: "place.present", placeId: "pl_1", from: "10.0.0.2" } as EventUnion);
    expect(await landed).toContain("signed in");
    emit({ type: "place.removed", placeId: "pl_1" } as EventUnion);
    await until(() => relay!.list().length === 0);
  });

  it("takes a page or a callback port from the computer only while a sign-in there runs, and closes the forward when that sign-in ends", async () => {
    const { port, box, forwards, lines } = await setup();
    box.push({ type: "browser.open", url: AUTH(port), port });
    box.push({ type: "callback.port", port });
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.list()).toEqual([]);
    expect(lines.filter(l => l.includes("no sign-in runs there"))).toHaveLength(2);
    const signIn = forwards()!.open({ placeId: "pl_1" })!;
    box.push({ type: "browser.open", url: AUTH(port), port });
    await until(() => relay!.list().length === 1);
    signIn.close();
    expect(relay!.list()).toEqual([]);
    expect(lines.some(l => l.includes(`stopped forwarding localhost:${port} (the sign-in ended)`))).toBe(true);
    box.push({ type: "callback.port", port });
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.list()).toEqual([]);
    // A sign-in that ends while its bind is in flight leaves nothing listening, another sign-in there or not.
    const other = forwards()!.open({ placeId: "pl_1" })!;
    const brief = forwards()!.open({ placeId: "pl_1" })!;
    const armed = brief.arm(AUTH(port));
    brief.close();
    expect(await armed).toBe(false);
    expect(relay!.list()).toEqual([]);
    other.close();
    await expect(brief.deliver(`http://localhost:${port}/callback?code=LATE`)).rejects.toThrow(/ended/);
  });

  it("keeps a port for each sign-in running on one computer, and a landed address reaches its own sign-in's port only", async () => {
    const { h, port, second, forwards } = await setup();
    const one = forwards()!.open({ placeId: "pl_1" })!;
    const two = forwards()!.open({ placeId: "pl_1" })!;
    expect(await one.arm(AUTH(port))).toBe(true);
    expect(await two.arm(AUTH(second))).toBe(true);
    expect(relay!.list().map(f => f.port).sort()).toEqual([port, second].sort());
    await one.deliver(`http://localhost:${port}/callback?code=ONE`);
    await two.deliver(`http://localhost:${second}/callback?code=TWO`);
    expect(h.heard.join("")).toMatch(/code=ONE[\s\S]*code=TWO/);
    await expect(one.deliver(`http://localhost:${second}/callback?code=x`)).rejects.toThrow(/not the port/);
    one.close();
    expect(relay!.list().map(f => f.port)).toEqual([second]);
    two.close();
    expect(relay!.list()).toEqual([]);
  });

  it("stops reading a harness's answer to a landed address at the held-callback cap, closes that tunnel, and quotes a short line", async () => {
    const flood = createServer(c => {
      c.on("error", () => {});
      c.on("data", () => c.write(Buffer.alloc(CALLBACK_HOLD_MAX_BYTES * 4, 0x41)));
    });
    await new Promise<void>(r => flood.listen(0, "127.0.0.1", r));
    const { port, box, forwards } = await setup({ server: flood, port: (flood.address() as { port: number }).port, heard: [] });
    const forward = forwards()!.open({ placeId: "pl_1" })!;
    await forward.arm(AUTH(port));
    const started = Date.now();
    const refused = await forward.deliver(`http://localhost:${port}/callback?code=C`).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(refused?.message).toMatch(/more than 64 KB/);
    expect(refused!.message.length).toBeLessThan(300);
    expect(Date.now() - started).toBeLessThan(5_000);
    await until(() => box.ops.some(o => o.op === "tunnel.close"));
  });
});
