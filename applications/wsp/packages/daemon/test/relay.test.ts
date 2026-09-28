// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in relay a daemon runs for a guest, over the wire: the shim socket
// it binds, the browser.open and callback.port it pushes, and the tunnels a
// laptop reaches a guest's loopback port through.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fakeProcTree, setListeners } from "./fake-proc.js";
import { daemonUnderTest, type DaemonUnderTest } from "./harness.js";
import { rejectedEvents } from "./wire-events.js";

const execFileAsync = promisify(execFile);
const TOKEN = "relay-token";

// URLs as the tools build them (measurement 2026-09-03); state and challenge values are placeholders.
const WRANGLER =
  "https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d11594&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Foauth%2Fcallback&scope=account%3Aread&state=S&code_challenge=C&code_challenge_method=S256";
const MCP_REMOTE =
  "https://mcp.linear.app/authorize?response_type=code&client_id=X&code_challenge=C&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A22227%2Foauth%2Fcallback&state=S&scope=read+write&resource=https%3A%2F%2Fmcp.linear.app%2Fmcp";
const GH_DEVICE = "https://github.com/login/device";

interface WireMsg {
  id?: number | null;
  ok?: boolean;
  type?: string;
  [k: string]: unknown;
}

/** Every event frame any client in this file received, checked against the protocol at the end. */
const wire: WireMsg[] = [];

async function client(port: number): Promise<{ request(op: string, p?: Record<string, unknown>): Promise<WireMsg>; events: WireMsg[]; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const events: WireMsg[] = [];
  const pending = new Map<number, (m: WireMsg) => void>();
  let nextId = 0;
  ws.on("message", raw => {
    const m = JSON.parse(String(raw)) as WireMsg;
    if (typeof m.id === "number" && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    } else if (m.type) {
      wire.push(m);
      if (m.type !== "daemon.hello") events.push(m);
    }
  });
  const request = (op: string, p: Record<string, unknown> = {}): Promise<WireMsg> => {
    const id = nextId++;
    return new Promise(resolve => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, op, ...p }));
    });
  };
  // A broadcast reaches only sockets whose auth frame the daemon has handled; the reply is the proof it has.
  await request("auth", { token: TOKEN });
  return { events, request, close: () => ws.close() };
}

/** True when nothing listens on host:port at this moment. */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? resolve(false) : reject(e)));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** [::1] only, at a port free on 127.0.0.1: the daemon dials v4 first and must be refused there, not answered by another test's server. */
async function listenV6Only(server: Server): Promise<number> {
  for (;;) {
    await new Promise<void>(r => server.listen(0, "::1", r));
    const port = (server.address() as { port: number }).port;
    if (await canBind(port, "127.0.0.1")) return port;
    await new Promise<void>(r => server.close(() => r()));
  }
}

/** A port nothing listens on, on either loopback address the daemon dials. */
async function refusedPort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>(r => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => r(p));
      });
    });
    if (await canBind(port, "::1")) return port;
  }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 15));
  }
}

describe("daemon: browser.open, callback.port and tunnels", () => {
  let daemon: DaemonUnderTest | undefined;
  let dir: string | undefined;
  let echo: Server | undefined;
  /** The fake machine the daemon reads its listening ports off. */
  let procRoot: string;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await new Promise<void>(r => (echo ? echo.close(() => r()) : r()));
    echo = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    rmSync(procRoot, { recursive: true, force: true });
  });

  async function start(): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "wsp-relay-daemon-"));
    const sockPath = join(dir, "open.sock");
    procRoot = fakeProcTree([]);
    daemon = await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, openSocket: sockPath, procRoot, portsIntervalMs: 20 });
    return sockPath;
  }

  const shim = (sockPath: string, url: string): Promise<void> =>
    execFileAsync("curl", ["-s", "-o", "/dev/null", "--unix-socket", sockPath, "-X", "POST", "--data-binary", url, "http://wsp/open"]).then(() => {});

  it("a shim post becomes browser.open on every authed socket, with the port when the URL names one", async () => {
    const sockPath = await start();
    const a = await client(daemon!.port);
    const b = await client(daemon!.port);
    await shim(sockPath, WRANGLER);
    await until(() => a.events.length > 0 && b.events.length > 0);
    expect(a.events).toEqual([{ type: "browser.open", url: WRANGLER, port: 8976 }]);
    expect(b.events).toEqual([{ type: "browser.open", url: WRANGLER, port: 8976 }]);
    a.close();
    b.close();
  });

  it("a URL without a port is followed by callback.port once a loopback listener appears", async () => {
    const sockPath = await start();
    const c = await client(daemon!.port);
    await c.request("ports.watch");
    await shim(sockPath, GH_DEVICE);
    await until(() => c.events.some(e => e.type === "browser.open"));
    expect(c.events.find(e => e.type === "browser.open")).toEqual({ type: "browser.open", url: GH_DEVICE });
    setListeners(procRoot, [
      { port: 3000, pid: 1 },
      { port: 45543, pid: 2, loopback: true },
    ]);
    await until(() => c.events.some(e => e.type === "callback.port"));
    expect(c.events.filter(e => e.type === "callback.port")).toEqual([{ type: "callback.port", port: 45543 }]);
    expect(c.events.find(e => e.type === "port.open" && e["port"] === 45543)).toMatchObject({ loopback: true });
    c.close();
  });

  it("a listener already on the machine when the watcher first polls is never the flow's, even for an open that came first", async () => {
    const sockPath = await start();
    // Listening before anyone asked for ports, so the watcher's first poll finds it there.
    setListeners(procRoot, [{ port: 3000, pid: 1, loopback: true }]);
    const c = await client(daemon!.port);
    // The open arrives before anyone has asked for ports; the watcher's first poll must not answer it with 3000.
    await shim(sockPath, GH_DEVICE);
    await until(() => c.events.some(e => e.type === "browser.open"));
    // The reply still seeds the subscriber with what was already listening.
    const watched = await c.request("ports.watch");
    expect((watched["ports"] as { port: number }[]).map(p => p.port)).toEqual([3000]);
    await new Promise(r => setTimeout(r, 150));
    expect(c.events.filter(e => e.type === "callback.port")).toEqual([]);
    setListeners(procRoot, [
      { port: 3000, pid: 1, loopback: true },
      { port: 45543, pid: 2, loopback: true },
    ]);
    await until(() => c.events.some(e => e.type === "callback.port"));
    expect(c.events.filter(e => e.type === "callback.port")).toEqual([{ type: "callback.port", port: 45543 }]);
    c.close();
  });

  it("a printed URL in a pty names the callback port even when no shim ran", async () => {
    await start();
    const c = await client(daemon!.port);
    const created = await c.request("pty.create", { shell: "bash" });
    const ptyId = created["ptyId"] as string;
    await c.request("pty.write", { ptyId, data: `printf '%s\\n' 'Visit: ${MCP_REMOTE}'\n` });
    await until(() => c.events.some(e => e.type === "callback.port"));
    expect(c.events.filter(e => e.type === "callback.port")).toEqual([{ type: "callback.port", port: 22227 }]);
    expect(c.events.some(e => e.type === "browser.open")).toBe(false);
    c.close();
  });

  it("tunnels a laptop connection to a guest loopback port: open, write, data, end, close", async () => {
    await start();
    echo = createServer(s => {
      s.on("data", d => s.write(Buffer.from(`echo:${d.toString()}`)));
      s.on("end", () => s.end());
    });
    const port = await listenV6Only(echo);
    const c = await client(daemon!.port);
    const opened = await c.request("tunnel.open", { tunnelId: "t1", port });
    expect(opened.ok).toBe(true);
    await c.request("tunnel.write", { tunnelId: "t1", data: Buffer.from("GET /oauth/callback?code=x HTTP/1.1\r\n").toString("base64") });
    await until(() => c.events.some(e => e.type === "tunnel.data"));
    const data = c.events.find(e => e.type === "tunnel.data")!;
    expect(Buffer.from(data["data"] as string, "base64").toString()).toBe("echo:GET /oauth/callback?code=x HTTP/1.1\r\n");
    await c.request("tunnel.close", { tunnelId: "t1" });
    const late = await c.request("tunnel.write", { tunnelId: "t1", data: "" });
    expect(late.ok).toBe(false);
    expect(late["code"]).toBe("not-found");
    c.close();
  });

  it("refuses a bad port, a duplicate id and a port nothing listens on", async () => {
    await start();
    const c = await client(daemon!.port);
    expect((await c.request("tunnel.open", { tunnelId: "x", port: 0 })).ok).toBe(false);
    const refused = await c.request("tunnel.open", { tunnelId: "x", port: await refusedPort() });
    expect(refused.ok).toBe(false);
    expect(String(refused["error"])).toMatch(/ECONNREFUSED/);
    echo = createServer(s => s.end());
    await new Promise<void>(r => echo!.listen(0, "127.0.0.1", r));
    const port = (echo.address() as { port: number }).port;
    expect((await c.request("tunnel.open", { tunnelId: "dup", port })).ok).toBe(true);
    await until(() => c.events.some(e => e.type === "tunnel.end" && e["tunnelId"] === "dup"));
    c.close();
  });
});

describe("wire", () => {
  it("every event the daemon pushed in this file is one the protocol parses", () => {
    expect(wire.length).toBeGreaterThan(0);
    expect(rejectedEvents(wire)).toEqual([]);
  });
});
