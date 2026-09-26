import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { DAEMON_AUTH_DEADLINE_PASSED, DAEMON_FIRST_FRAME_NOT_AUTH, DAEMON_PRE_AUTH_BYTES_EXCEEDED, DAEMON_TOKEN_REFUSED, DAEMON_VERSION, TUNNEL_CAP, portScopeRefusal, unknownOpLine } from "@wsp/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { fakeProcTree, fakeStty, writeProc } from "./fake-proc.js";
import { daemonUnderTest, type DaemonUnderTest } from "./harness.js";
import { rejectedEvents } from "./wire-events.js";

function lanIPv4(): string | null {
  for (const infos of Object.values(networkInterfaces())) {
    for (const i of infos ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return null;
}

const TOKEN = "test-token-123";

interface WireMsg {
  id?: string | number | null;
  ok?: boolean;
  type?: string;
  [k: string]: unknown;
}

/** Every event frame any client in this file received, checked against the protocol at the end. */
const wire: WireMsg[] = [];

class Client {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (m: WireMsg) => void>();
  readonly events: WireMsg[] = [];
  /** Every frame in arrival order, replies and events alike. */
  readonly frames: WireMsg[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise(resolve => ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })));
    ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as WireMsg;
      this.frames.push(m);
      if (typeof m.id === "number" && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else if (m.type) {
        this.events.push(m);
        wire.push(m);
      }
    });
  }

  /** Opens the socket and sends the auth frame first, as every real client does, and like them sends nothing more
   * until it is answered (or the socket closes). scopePort names the one guest port this socket is for. */
  static async connect(port: number, token: string, host = "127.0.0.1", scopePort?: number): Promise<Client> {
    const ws = new WebSocket(`ws://${host}:${port}/`);
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await Promise.race([client.request("auth", { token, ...(scopePort !== undefined ? { port: scopePort } : {}) }), client.closed]);
    return client;
  }

  request(op: string, params: Record<string, unknown> = {}): Promise<WireMsg> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, op, ...params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

let daemon: DaemonUnderTest;

afterAll(async () => {
  await daemon?.close();
});

/** How many ptys the daemon holds, asked over the wire as any client would. */
async function ptyCount(port: number): Promise<number> {
  const c = await Client.connect(port, TOKEN);
  const listed = await c.request("pty.list");
  c.close();
  return (listed["ptys"] as unknown[]).length;
}

describe("daemon WS server", () => {
  it("closes 4401 with one sentence when the auth frame carries the wrong token", async () => {
    daemon = await daemonUnderTest({ port: 0, token: TOKEN });
    const c = await Client.connect(daemon.port, "wrong");
    const { code, reason } = await c.closed;
    expect(code).toBe(4401);
    expect(reason).toBe(DAEMON_TOKEN_REFUSED);
    expect(c.frames).toEqual([]);
  });

  it("answers a plain HTTP request 426 Upgrade Required, the one status the host's probe reads as a daemon", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/`);
    expect(res.status).toBe(426);
    await res.text();
    // The door still serves: the same daemon takes an upgrade and its auth frame after.
    const c = await Client.connect(daemon.port, TOKEN);
    expect((await c.request("ping")).ok).toBe(true);
    c.close();
  });

  it("the query token no longer authenticates: a socket dialled with ?token= still needs the frame", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/?token=${TOKEN}`);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, op: "ping" })));
    const code = await new Promise<number>(resolve => ws.once("close", c => resolve(c)));
    expect(code).toBe(4401);
  });

  it("closes a socket whose first frame is not auth 4401 before any handler runs", async () => {
    const before = await ptyCount(daemon.port);
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, op: "pty.create", shell: "bash" }));
      ws.send(JSON.stringify({ id: 2, op: "auth", token: TOKEN }));
      ws.send(JSON.stringify({ id: 3, op: "pty.create", shell: "bash" }));
    });
    const replies: WireMsg[] = [];
    ws.on("message", raw => replies.push(JSON.parse(String(raw)) as WireMsg));
    const [code, reason] = await new Promise<[number, string]>(resolve => ws.once("close", (c, r) => resolve([c, String(r)])));
    expect(code).toBe(4401);
    expect(reason).toBe(DAEMON_FIRST_FRAME_NOT_AUTH);
    await new Promise(r => setTimeout(r, 100));
    expect(await ptyCount(daemon.port)).toBe(before);
    expect(replies).toEqual([]);
  });

  it("a malformed frame from a peer that never authed ends that socket and nothing else", async () => {
    // Upgrade by hand, then one frame with RSV1 set (no extension negotiated it): ws rejects the frame as an error.
    const raw = connect({ host: "127.0.0.1", port: daemon.port });
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    raw.on("error", () => {}); // the daemon may reset the connection while the close frame is still being read
    raw.write(["GET / HTTP/1.1", `Host: 127.0.0.1:${daemon.port}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"));
    await new Promise<void>(resolve => raw.once("data", () => resolve()));
    raw.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0]));
    await new Promise<void>(resolve => raw.once("close", () => resolve()));

    const c = await Client.connect(daemon.port, TOKEN);
    expect((await c.request("ping")).ok).toBe(true);
    c.close();
  });

  it("closes 4401 a socket that sends more than a few KiB before its auth frame, and keeps serving", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/`);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, op: "auth", token: TOKEN, pad: "x".repeat(16 * 1024) })));
    const replies: WireMsg[] = [];
    ws.on("message", raw => replies.push(JSON.parse(String(raw)) as WireMsg));
    const [code, reason] = await new Promise<[number, string]>(resolve => ws.once("close", (c, r) => resolve([c, String(r)])));
    expect(code).toBe(4401);
    expect(reason).toBe(DAEMON_PRE_AUTH_BYTES_EXCEEDED);
    expect(replies).toEqual([]);

    // The cap is for the pre-auth window only: an authed socket sends the same bytes and is answered.
    const c = await Client.connect(daemon.port, TOKEN);
    expect((await c.request("ping", { pad: "x".repeat(16 * 1024) })).ok).toBe(true);
    c.close();
  });

  it("counts wire bytes, not assembled messages: a peer that never finishes a huge frame is cut at the cap", async () => {
    const raw = connect({ host: "127.0.0.1", port: daemon.port });
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    raw.on("error", () => {}); // the daemon may reset the connection while the close frame is still being read
    raw.write(["GET / HTTP/1.1", `Host: 127.0.0.1:${daemon.port}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"));
    await new Promise<void>(resolve => raw.once("data", () => resolve()));
    // One masked text frame announcing 50 MiB, then only 8 KiB of it: under ws's own cap, so ws would sit and buffer.
    const header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(50 * 1024 * 1024), 2);
    raw.write(Buffer.concat([header, Buffer.alloc(8 * 1024, 0x20)]));
    const closeFrame = await new Promise<Buffer>(resolve => raw.once("data", d => resolve(Buffer.from(d))));
    expect(closeFrame[0]).toBe(0x88);
    expect(closeFrame.readUInt16BE(2)).toBe(4401);
    // Anything more from that peer ends the connection outright.
    raw.write(Buffer.alloc(8 * 1024, 0x20));
    await new Promise<void>(resolve => raw.once("close", () => resolve()));

    const c = await Client.connect(daemon.port, TOKEN);
    expect((await c.request("ping")).ok).toBe(true);
    c.close();
  });

  it("a socket authed for one port may tunnel to that port and nothing else", async () => {
    // Answers only once asked, so the tunnel is still open when the write arrives.
    const guest: Server = createServer(sock => sock.once("data", () => sock.end("hello from the guest")));
    await new Promise<void>(resolve => guest.listen(0, "127.0.0.1", () => resolve()));
    const guestPort = (guest.address() as { port: number }).port;
    try {
      const before = await ptyCount(daemon.port);
      const c = await Client.connect(daemon.port, TOKEN, "127.0.0.1", guestPort);
      expect((await c.request("ping")).ok).toBe(true);

      const forbidden = async (op: string, params: Record<string, unknown> = {}) => {
        const r = await c.request(op, params);
        expect(r.ok).toBe(false);
        expect(r["code"]).toBe("forbidden");
        expect(r["error"]).toBe(portScopeRefusal(guestPort));
      };
      await forbidden("pty.create", { shell: "bash" });
      await forbidden("pty.list");
      await forbidden("fs.list", { path: "." });
      await forbidden("git.status", { cwd: "." });
      await forbidden("ports.watch");
      await forbidden("sys.watch");
      await forbidden("proc.watch");
      await forbidden("proc.inspect", { pid: 1 });
      await forbidden("proc.kill", { pid: 1, signal: "TERM" });
      await forbidden("manifest.get");
      await forbidden("tunnel.open", { tunnelId: "other", port: guestPort + 1 });
      expect(await ptyCount(daemon.port)).toBe(before);

      expect((await c.request("tunnel.open", { tunnelId: "t1", port: guestPort })).ok).toBe(true);
      expect((await c.request("tunnel.write", { tunnelId: "t1", data: Buffer.from("GET").toString("base64") })).ok).toBe(true);
      const deadline = Date.now() + 2000;
      while (!c.events.some(e => e.type === "tunnel.end") && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      const data = c.events.filter(e => e.type === "tunnel.data").map(e => Buffer.from(String(e["data"]), "base64").toString()).join("");
      expect(data).toBe("hello from the guest");
      expect((await c.request("tunnel.close", { tunnelId: "t1" })).ok).toBe(true);
      c.close();

      // An unscoped socket on the same token still has every op.
      const full = await Client.connect(daemon.port, TOKEN);
      expect((await full.request("pty.list")).ok).toBe(true);
      full.close();
    } finally {
      await new Promise<void>(resolve => guest.close(() => resolve()));
    }
  });

  it("an unscoped socket tunnels to any guest port, holds at most the cap at once, and loses them all with the socket", async () => {
    const guestSide = new Set<Socket>();
    const echo: Server = createServer(sock => {
      guestSide.add(sock);
      sock.on("close", () => guestSide.delete(sock));
      sock.on("data", d => sock.write(Buffer.from(`echo:${d.toString()}`)));
    });
    await new Promise<void>(resolve => echo.listen(0, "127.0.0.1", () => resolve()));
    const port = (echo.address() as { port: number }).port;
    const tunnelled = (c: Client, type: string, tunnelId: string) => c.events.find(e => e.type === type && e["tunnelId"] === tunnelId);
    try {
      const c = await Client.connect(daemon.port, TOKEN);
      for (let i = 0; i < TUNNEL_CAP; i++) expect((await c.request("tunnel.open", { tunnelId: `t${i}`, port })).ok).toBe(true);
      expect(await c.request("tunnel.open", { tunnelId: "one-more", port })).toMatchObject({ ok: false, code: "bad-request", error: `too many tunnels open (${TUNNEL_CAP})` });
      expect(await c.request("tunnel.open", { tunnelId: "t0", port })).toMatchObject({ ok: false, code: "bad-request", error: "tunnel t0 is already open" });
      // Every one of them carries bytes both ways, and closing one frees its place.
      expect((await c.request("tunnel.write", { tunnelId: "t63", data: Buffer.from("x").toString("base64") })).ok).toBe(true);
      await vi.waitFor(() => expect(tunnelled(c, "tunnel.data", "t63")).toBeDefined(), { timeout: 5000, interval: 10 });
      expect(Buffer.from(String(tunnelled(c, "tunnel.data", "t63")!["data"]), "base64").toString()).toBe("echo:x");
      expect((await c.request("tunnel.close", { tunnelId: "t63" })).ok).toBe(true);
      await vi.waitFor(() => expect(tunnelled(c, "tunnel.end", "t63")).toBeDefined(), { timeout: 5000, interval: 10 });
      expect(await c.request("tunnel.write", { tunnelId: "t63", data: "" })).toMatchObject({ ok: false, code: "not-found" });
      expect((await c.request("tunnel.open", { tunnelId: "one-more", port })).ok).toBe(true);
      c.close();
      // The tunnels die with the socket: the guest sees every connection end, and the next client starts from nothing.
      await vi.waitFor(() => expect(guestSide.size).toBe(0), { timeout: 5000, interval: 10 });
      const again = await Client.connect(daemon.port, TOKEN);
      for (let i = 0; i < TUNNEL_CAP; i++) expect((await again.request("tunnel.open", { tunnelId: `t${i}`, port })).ok).toBe(true);
      again.close();
    } finally {
      for (const sock of guestSide) sock.destroy();
      await new Promise<void>(resolve => echo.close(() => resolve()));
    }
  });

  it("refuses an auth frame whose port is not a port", async () => {
    const c = await Client.connect(daemon.port, TOKEN, "127.0.0.1", 70000);
    const { code, reason } = await c.closed;
    expect(code).toBe(4401);
    expect(reason).toBe(DAEMON_FIRST_FRAME_NOT_AUTH);
  });

  it("ignores an exported WSP_DAEMON_TOKEN: the file is the only source, so an export cannot pin a token past a rotation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-daemon-env-"));
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "fromfile\n");
    vi.stubEnv("WSP_DAEMON_TOKEN", "fromenv");
    const d = await daemonUnderTest({ port: 0, tokenPath });
    try {
      const env = await Client.connect(d.port, "fromenv");
      expect((await env.closed).code).toBe(4401);
      const file = await Client.connect(d.port, "fromfile");
      expect((await file.request("ping")).ok).toBe(true);
      file.close();
    } finally {
      vi.unstubAllEnvs();
      await d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes a socket that sends nothing before the auth deadline", async () => {
    const d = await daemonUnderTest({ port: 0, token: TOKEN, authDeadlineMs: 60 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${d.port}/`);
      const [code, reason] = await new Promise<[number, string]>(resolve => ws.once("close", (c, r) => resolve([c, String(r)])));
      expect(code).toBe(4401);
      expect(reason).toBe(DAEMON_AUTH_DEADLINE_PASSED);
    } finally {
      await d.close();
    }
  });

  it("checks each auth frame against the token file as it is now: a rotated file refuses the old token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-daemon-token-"));
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "first\n");
    const d = await daemonUnderTest({ port: 0, tokenPath });
    try {
      const c1 = await Client.connect(d.port, "first");
      expect((await c1.request("ping")).ok).toBe(true);

      writeFileSync(tokenPath, "second\n");
      const stale = await Client.connect(d.port, "first");
      expect((await stale.closed).code).toBe(4401);
      const fresh = await Client.connect(d.port, "second");
      expect((await fresh.request("ping")).ok).toBe(true);
      // An authed socket stays authed through the rotation; only new dials are checked.
      expect((await c1.request("ping")).ok).toBe(true);
      c1.close();
      fresh.close();
    } finally {
      await d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the port it bound where the port file names, for a caller that asked for a free one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-daemon-port-"));
    const portFile = join(dir, "daemon.port");
    const d = await daemonUnderTest({ port: 0, token: TOKEN, portFile });
    try {
      expect(readFileSync(portFile, "utf8")).toBe(`${d.port}\n`);
    } finally {
      await d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers the auth frame, then greets with its root and version before anything else", async () => {
    const c = await Client.connect(daemon.port, TOKEN);
    const pong = await c.request("ping");
    expect(pong.ok).toBe(true);
    expect(c.frames.slice(0, 2)).toEqual([
      { id: 1, ok: true },
      { type: "daemon.hello", root: resolve(process.env["HOME"] ?? homedir()), version: DAEMON_VERSION },
    ]);
    c.close();
  });

  it("answers an op it does not know with an error naming it, never with silence", async () => {
    const c = await Client.connect(daemon.port, TOKEN);
    expect(await c.request("sys.explode")).toMatchObject({ ok: false, error: unknownOpLine("sys.explode") });
    c.close();
  });

  it("accepts connections on non-loopback interfaces (previewUrl edge dials eth0)", async () => {
    const c = await Client.connect(daemon.port, TOKEN, lanIPv4() ?? "127.0.0.1");
    expect((await c.request("ping")).ok).toBe(true);
    c.close();
  });

  it("serves ptys that survive a client disconnect, replaying to the next client", async () => {
    const c1 = await Client.connect(daemon.port, TOKEN);
    const created = await c1.request("pty.create", { cols: 80, rows: 24, shell: "bash" });
    expect(created.ok).toBe(true);
    const ptyId = created["ptyId"] as string;
    await c1.request("pty.attach", { ptyId });
    await c1.request("pty.write", { ptyId, data: "echo WIRE-$((20+3))\n" });
    await new Promise(r => setTimeout(r, 300));
    c1.close(); // first client gone; pty must keep running

    await new Promise(r => setTimeout(r, 100));
    const c2 = await Client.connect(daemon.port, TOKEN);
    const listed = await c2.request("pty.list");
    expect((listed["ptys"] as { id: string; exited: boolean }[]).find(p => p.id === ptyId)?.exited).toBe(false);

    await c2.request("pty.write", { ptyId, data: "echo SECOND-CLIENT\n" });
    await new Promise(r => setTimeout(r, 300));
    await c2.request("pty.attach", { ptyId });
    await new Promise(r => setTimeout(r, 100));
    const seen = c2.events
      .filter(e => e.type === "pty.data")
      .map(e => e["data"])
      .join("");
    expect(seen).toContain("WIRE-23");
    expect(seen).toContain("SECOND-CLIENT");

    const bad = await c2.request("nonsense.op");
    expect(bad.ok).toBe(false);
    c2.close();
  });

  /** A daemon whose pty modes come off a fake stty first on its PATH and a fake /proc tree: the probe reads the
   * slave off fd 0 there, asks stty about it, and reads the foreground comm off the tpgid in stat. */
  async function daemonWithModes(): Promise<{ d: DaemonUnderTest; procRoot: string; stty: ReturnType<typeof fakeStty>; shell: (pid: number, foreground: string) => void }> {
    const stty = fakeStty();
    const procRoot = fakeProcTree([]);
    vi.stubEnv("PATH", `${stty.binDir}${delimiter}${process.env["PATH"] ?? ""}`);
    const d = await daemonUnderTest({ port: 0, token: TOKEN, procRoot, modeIntervalMs: 50 });
    // The shell's own entry: fd 0 on a slave, and a foreground group whose comm is what the pane shows.
    const shell = (pid: number, foreground: string): void => {
      writeProc(procRoot, { pid, comm: "bash", tpgid: 7001, stdin: "/dev/pts/9" });
      writeProc(procRoot, { pid: 7001, comm: foreground });
    };
    return { d, procRoot, stty, shell };
  }

  it("pushes pty.mode on attach and again only when the probed state changes", async () => {
    const { d, procRoot, stty, shell } = await daemonWithModes();
    try {
      const c = await Client.connect(d.port, TOKEN);
      const created = await c.request("pty.create", { shell: "bash" });
      const ptyId = created["ptyId"] as string;
      shell(created["pid"] as number, "bash");
      await c.request("pty.attach", { ptyId });
      const modes = () => c.events.filter(e => e.type === "pty.mode");
      await vi.waitFor(() => expect(modes()[0]).toMatchObject({ ptyId, mode: "line", echo: true, foreground: "bash" }), { timeout: 5_000, interval: 10 });

      // One change at a time, each waited for: a poll that saw no change pushed nothing, so the count is the changes.
      stty.setModes("-icanon -echo");
      await vi.waitFor(() => expect(modes().at(-1)).toMatchObject({ ptyId, mode: "raw", echo: false, foreground: "bash" }), { timeout: 5_000, interval: 10 });
      await new Promise(r => setTimeout(r, 150));
      expect(modes().length).toBe(2);
      shell(created["pid"] as number, "vim");
      await vi.waitFor(() => expect(modes().at(-1)).toMatchObject({ ptyId, mode: "raw", echo: false, foreground: "vim" }), { timeout: 5_000, interval: 10 });
      await new Promise(r => setTimeout(r, 150));
      expect(modes().length).toBe(3);
      c.close();
    } finally {
      vi.unstubAllEnvs();
      await d.close();
      rmSync(procRoot, { recursive: true, force: true });
    }
  });

  it("stops probing once the pty exits, even with the client still attached", async () => {
    const { d, procRoot, stty, shell } = await daemonWithModes();
    try {
      const c = await Client.connect(d.port, TOKEN);
      const created = await c.request("pty.create", { shell: "bash" });
      const ptyId = created["ptyId"] as string;
      shell(created["pid"] as number, "bash");
      await c.request("pty.attach", { ptyId });
      await c.request("pty.write", { ptyId, data: "exit\n" });
      const deadline = Date.now() + 3000;
      while (!c.events.some(e => e.type === "pty.exit") && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
      }
      expect(c.events.some(e => e.type === "pty.exit")).toBe(true);
      // The attach ran the probe at least once; a probe in flight at the exit lands after it. The count settles
      // over three of the probe's own intervals and then has to keep holding.
      const atExit = await vi.waitFor(
        async () => {
          const before = stty.calls();
          expect(before).toBeGreaterThan(0);
          await new Promise(r => setTimeout(r, 150));
          expect(stty.calls()).toBe(before);
          return before;
        },
        { timeout: 5_000, interval: 10 },
      );
      await new Promise(r => setTimeout(r, 300));
      expect(stty.calls()).toBe(atExit);

      // a late attach to the dead pty must not restart the loop either
      const c2 = await Client.connect(d.port, TOKEN);
      await c2.request("pty.attach", { ptyId });
      await new Promise(r => setTimeout(r, 300));
      expect(stty.calls()).toBe(atExit);
      expect(c2.events.some(e => e.type === "pty.exit")).toBe(true);
      c2.close();
      c.close();
    } finally {
      vi.unstubAllEnvs();
      await d.close();
      rmSync(procRoot, { recursive: true, force: true });
    }
  });
});

describe("wire", () => {
  it("every event the daemon pushed in this file is one the protocol parses", () => {
    expect(wire.length).toBeGreaterThan(0);
    expect(rejectedEvents(wire)).toEqual([]);
  });
});
