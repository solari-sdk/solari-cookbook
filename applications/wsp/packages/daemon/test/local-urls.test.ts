// SPDX-License-Identifier: AGPL-3.0-only
// Plain local URLs in pty output and in shim posts name the port the host
// forwards to the laptop's loopback: the localhost.url a daemon pushes for
// one, on the wire.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fakeProcTree, setListeners } from "./fake-proc.js";
import { daemonUnderTest, type DaemonUnderTest } from "./harness.js";
import { rejectedEvents } from "./wire-events.js";

const execFileAsync = promisify(execFile);
const TOKEN = "local-token";

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
      events.push(m);
      wire.push(m);
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

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 15));
  }
}

describe("daemon: localhost.url on the wire", () => {
  let daemon: DaemonUnderTest | undefined;
  let dir: string | undefined;
  /** The fake machine the daemon reads its listening ports off. */
  let procRoot: string;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    rmSync(procRoot, { recursive: true, force: true });
  });

  async function start(): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "wsp-local-urls-"));
    const sockPath = join(dir, "open.sock");
    procRoot = fakeProcTree([]);
    daemon = await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, openSocket: sockPath, procRoot, portsIntervalMs: 20 });
    return sockPath;
  }

  it("a local URL printed in a pty becomes one localhost.url with its port, on every authed socket", async () => {
    await start();
    const a = await client(daemon!.port);
    const b = await client(daemon!.port);
    const created = await a.request("pty.create", { shell: "bash" });
    const ptyId = created["ptyId"] as string;
    // The typed command echoes with the URL in it and the output prints it again: one event.
    await a.request("pty.write", { ptyId, data: "printf '%s\\n' 'Serving HTTP on 0.0.0.0 port 8123 (http://0.0.0.0:8123/) ...'\n" });
    await until(() => a.events.some(e => e.type === "localhost.url") && b.events.some(e => e.type === "localhost.url"));
    await new Promise(r => setTimeout(r, 300));
    expect(a.events.filter(e => e.type === "localhost.url")).toEqual([{ type: "localhost.url", port: 8123 }]);
    expect(b.events.filter(e => e.type === "localhost.url")).toEqual([{ type: "localhost.url", port: 8123 }]);
    expect(a.events.some(e => e.type === "callback.port" || e.type === "browser.open")).toBe(false);
    a.close();
    b.close();
  });

  it("a tool opening its own local page posts to the shim: localhost.url only, no browser.open and no callback listener awaited", async () => {
    const sockPath = await start();
    const c = await client(daemon!.port);
    await c.request("ports.watch");
    await execFileAsync("curl", ["-s", "-o", "/dev/null", "--unix-socket", sockPath, "-X", "POST", "--data-binary", "http://localhost:5173/", "http://wsp/open"]);
    await until(() => c.events.some(e => e.type === "localhost.url"));
    await new Promise(r => setTimeout(r, 100));
    // The sidebar row is the affordance; a "sign-in page" bar for a dev server would be a lie.
    expect(c.events.some(e => e.type === "browser.open")).toBe(false);
    expect(c.events.filter(e => e.type === "localhost.url")).toEqual([{ type: "localhost.url", port: 5173 }]);
    // A loopback listener appearing right after is not this open's callback.
    setListeners(procRoot, [{ port: 45543, pid: 2, loopback: true }]);
    await until(() => c.events.some(e => e.type === "port.open" && e["port"] === 45543));
    await new Promise(r => setTimeout(r, 100));
    expect(c.events.some(e => e.type === "callback.port")).toBe(false);
    c.close();
  });

  it("a local authorize page with a local redirect_uri (Supabase, Keycloak, Dex) is a sign-in and a local URL: browser.open with the callback port, plus localhost.url for the authorize host", async () => {
    const sockPath = await start();
    const c = await client(daemon!.port);
    await c.request("ports.watch");
    const url = "http://localhost:54321/auth/v1/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb";
    await execFileAsync("curl", ["-s", "-o", "/dev/null", "--unix-socket", sockPath, "-X", "POST", "--data-binary", url, "http://wsp/open"]);
    await until(() => c.events.some(e => e.type === "browser.open") && c.events.some(e => e.type === "localhost.url"));
    expect(c.events.filter(e => e.type === "browser.open")).toEqual([{ type: "browser.open", url, port: 3000 }]);
    expect(c.events.filter(e => e.type === "localhost.url")).toEqual([{ type: "localhost.url", port: 54321 }]);
    // The redirect_uri named the port, so no listener heuristic is armed.
    setListeners(procRoot, [{ port: 45543, pid: 2, loopback: true }]);
    await until(() => c.events.some(e => e.type === "port.open" && e["port"] === 45543));
    await new Promise(r => setTimeout(r, 100));
    expect(c.events.some(e => e.type === "callback.port")).toBe(false);
    c.close();
  });
});

describe("wire", () => {
  it("every event the daemon pushed in this file is one the protocol parses", () => {
    expect(wire.length).toBeGreaterThan(0);
    expect(rejectedEvents(wire)).toEqual([]);
  });
});
