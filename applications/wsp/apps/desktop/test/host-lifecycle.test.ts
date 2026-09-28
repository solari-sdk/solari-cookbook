// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialHost, hostTokenFor, localWiring, localWorkFolder, makeRuntime, severalAccountHostsLine, startHost, writeHost, type CliIO, type HostHandle, type HostRecord } from "@wsp/host";
import { WS_PATH, hostNoKeyLine } from "@wsp/protocol";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { copyingFake, fakeDaemonStart } from "../../../packages/host/test/verbs-fixture.js";
import { hostTokenMatches, locateHost, openHost, statePathIn, userDataIn, type HostSession } from "../src/host-lifecycle.js";
import { checkSetup } from "../src/setup.js";

const PAGE = `<!doctype html>
<html><head><title>wsp</title></head>
<body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>
</body></html>
`;

function fakeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-desktop-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), PAGE);
  return dir;
}

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
function quietIO(lines: string[] = []): CliIO {
  return { log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt };
}

function testRuntime(): Runtime {
  return createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
}

function listen(server: Server | TcpServer): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

function closeServer(server: Server | TcpServer): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function bootOf(url: string): Promise<{ wsPort: number; tokenHash?: string; token?: string } | undefined> {
  const html = await (await fetch(url)).text();
  const m = html.match(/window\.__WSP__ = (\{[^<]*\});<\/script>/);
  return m ? (JSON.parse(m[1]!) as { wsPort: number; tokenHash?: string; token?: string }) : undefined;
}

/** A sha256 in hex, which is what the loopback page carries of the host's token. */
const DIGEST = /^[0-9a-f]{64}$/;
const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A host's page as another process on this computer sees it pass by: every request the window sent, with the
 * headers it carried, forwarded to the real host and answered as it answered. */
async function recording(upstream: number): Promise<{ port: number; requests: { url: string; authorization?: string }[]; close(): Promise<void> }> {
  const requests: { url: string; authorization?: string }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    requests.push({ url: req.url ?? "", ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}) });
    void fetch(`http://127.0.0.1:${upstream}${req.url ?? "/"}`).then(async from => {
      res.writeHead(from.status, { "content-type": from.headers.get("content-type") ?? "text/plain" });
      res.end(Buffer.from(await from.arrayBuffer()));
    });
  });
  const port = await listen(server);
  return { port, requests, close: () => closeServer(server) };
}

/** A pid that was real a moment ago and is not alive now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid;
}

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

/** Whether this machine has an IPv6 loopback to bind at all: a runner without one cannot hold the ::1 case. */
const ipv6Loopback = await new Promise<boolean>(resolve => {
  const probe = createTcpServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

async function refused(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
}

/** Whether nothing holds this port on loopback: a server of our own binds it and lets it go. */
function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createTcpServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

describe("openHost", () => {
  let home: string;
  let session: HostSession | undefined;
  let existing: HostHandle | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-desktop-home-"));
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_desktop_key");
    vi.stubEnv("HOME", home);
    vi.stubEnv("WSP_HOME", home);
  });
  afterEach(async () => {
    await session?.close();
    await existing?.close();
    session = undefined;
    existing = undefined;
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function open(port: number, wsPort: number): Promise<HostSession> {
    return openHost({
      port,
      wsPort,
      statePath: join(home, "state.json"),
      webDir: fakeWebDir(),
      io: quietIO(),
      runtime: testRuntime(),
    });
  }

  it("the host inside the app writes every line it says, and one per refused frame, to host.log beside the state file", async () => {
    const lines: string[] = [];
    const statePath = join(home, "state.json");
    session = await openHost({ port: 0, wsPort: 0, statePath, webDir: fakeWebDir(), io: quietIO(lines), runtime: testRuntime() });
    const ws = new WebSocket(`${session.url.replace(/^http/, "ws")}${WS_PATH}`);
    const replies: { id?: number; ok?: boolean }[] = [];
    ws.onmessage = m => replies.push(JSON.parse(String(m.data)) as { id?: number; ok?: boolean });
    await new Promise(resolve => (ws.onopen = resolve));
    ws.send(JSON.stringify({ id: 1, op: "auth", token: hostTokenFor(statePath) }));
    ws.send(JSON.stringify({ id: 2, op: "workspaces.get", workspaceId: "nope" }));
    await vi.waitFor(() => expect(replies.find(r => r.id === 2)).toMatchObject({ ok: false }));
    ws.close();
    const logged = readFileSync(join(home, "host.log"), "utf8").split("\n").filter(l => l !== "");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).toEqual(lines);
    expect(logged.some(l => l.startsWith("refused workspaces.get "))).toBe(true);
  }, 20_000);

  /** A record wsp hosts wrote off the account's listing: the address the relay named, the key pinned at first
   * sight, and no token until a dial admits this computer over there. */
  const accountRecord = (over: Partial<HostRecord> = {}): HostRecord => ({
    url: "https://hbox1.boxes.example",
    deviceId: "",
    deviceToken: "",
    hostKey: "SHA256:box",
    pairedAt: "2026-09-20T10:00:00.000Z",
    via: { kind: "account", hostId: "hbox1" },
    ...over,
  });

  /** The relay record a linked host keeps beside its state file, which is what says which host on the account is
   * this computer. */
  function linkedAs(hostId: string): void {
    writeFileSync(join(home, "relay.json"), JSON.stringify({ relayUrl: "https://relay.example", hostId, token: "host-relay-token", name: hostId, linkedAt: "2026-09-20T09:00:00.000Z" }));
  }

  /** A socket that carries nothing: the dial below is asked for a token, not for a conversation. */
  const stubClient = (): Awaited<ReturnType<typeof dialHost>> => ({
    request: async <T extends Record<string, unknown>>(): Promise<T> => ({}) as T,
    events: async () => {},
    onFrame: () => () => {},
    closed: Promise.resolve(),
    closeWords: () => "",
    close: () => {},
    terminate: () => {},
  });

  /** The command line's dial as this window uses it, with the window it was given: handed an answer it writes that
   * token into the record under the alias it was aimed at, which is what the real one does on the admit road, and
   * handed none it only opens, which is every record that already holds a token. */
  function admittingDial(answered?: { deviceId: string; deviceToken: string }): { dial: typeof dialHost; dialled: string[]; windows: (number | undefined)[] } {
    const dialled: string[] = [];
    const windows: (number | undefined)[] = [];
    return {
      dialled,
      windows,
      dial: async (_statePath, opts = {}) => {
        const aim = opts.aim;
        if (aim?.kind !== "alias") throw new Error(`the window dialled ${JSON.stringify(aim)} rather than a saved host`);
        dialled.push(aim.alias);
        windows.push(opts.deadlineMs);
        if (answered !== undefined) writeHost(opts.home ?? home, aim.alias, { ...aim.record, ...answered });
        return stubClient();
      },
    };
  }

  function openWith(dial: typeof dialHost, lines: string[] = [], runtime: Runtime = testRuntime()): Promise<HostSession> {
    return openHost({ port: 0, wsPort: 0, statePath: join(home, "state.json"), webDir: fakeWebDir(), io: quietIO(lines), runtime, dial });
  }

  it("opens on the one host the account names, after one dial that admits this computer there, and starts no host here", async () => {
    writeHost(home, "box", accountRecord());
    const { dial, dialled, windows } = admittingDial({ deviceId: "d_2", deviceToken: "tok-fresh" });
    const runtime = testRuntime();
    const closed = vi.spyOn(runtime, "close");
    session = await openWith(dial, [], runtime);
    expect(dialled).toEqual(["box"]);
    // A person is watching an empty window while this dial waits, so it is well under the fifteen seconds a line
    // at a terminal gives a relayed road, and over the hold that road was measured at, which the constant names.
    expect(windows[0]).toBeGreaterThan(0);
    expect(windows[0]).toBeLessThan(10_000);
    // The runtime the setup gate built serves nothing here, so it goes rather than lingering behind the window.
    expect(closed).toHaveBeenCalledOnce();
    expect(session).toMatchObject({ url: "https://hbox1.boxes.example", owned: false, remote: true, alias: "box", label: "box", deviceToken: "tok-fresh" });
    // Nothing was started on this computer: no lock beside the state file, and the token the page is handed is
    // the one the dial wrote into the record.
    expect(existsSync(join(home, "host.lock"))).toBe(false);
  });

  it("starts a host here when the one host on the account is this computer, which is where a line with no name goes anyway", async () => {
    writeHost(home, "macbook", accountRecord({ via: { kind: "account", hostId: "hmac" } }));
    linkedAs("hmac");
    const { dial, dialled } = admittingDial();
    session = await openWith(dial);
    expect(dialled).toEqual([]);
    expect(session).toMatchObject({ owned: true, remote: false });
    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 20_000);

  it("starts a host here and says why when the account names several hosts", async () => {
    writeHost(home, "box", accountRecord());
    writeHost(home, "attic", accountRecord({ url: "https://hattic.boxes.example", hostKey: "SHA256:attic", via: { kind: "account", hostId: "hattic" } }));
    const lines: string[] = [];
    const { dial, dialled } = admittingDial();
    session = await openWith(dial, lines);
    expect(dialled).toEqual([]);
    expect(session.owned).toBe(true);
    expect(lines.join("\n")).toContain(severalAccountHostsLine(["attic", "box"]));
  }, 20_000);

  it("starts a host here over a record a pairing code left, which names no account and is read as no record", async () => {
    mkdirSync(join(home, "hosts"), { recursive: true });
    writeFileSync(join(home, "hosts", "lan.json"), JSON.stringify({ url: "http://192.168.1.9:4400", deviceId: "d_9", deviceToken: "tok-lan", hostKey: "SHA256:lan", pairedAt: "2026-09-01T00:00:00.000Z" }));
    const { dial, dialled } = admittingDial();
    session = await openWith(dial);
    expect(dialled).toEqual([]);
    expect(session).toMatchObject({ owned: true, remote: false });
  }, 20_000);

  it("starts a host here and prints the host's own sentence when the account's host refuses this computer", async () => {
    writeHost(home, "box", accountRecord());
    const lines: string[] = [];
    const refusing: typeof dialHost = async () => {
      throw Object.assign(new Error("this host admits no device under that key"), { kind: "auth" });
    };
    session = await openWith(refusing, lines);
    expect(session).toMatchObject({ owned: true, remote: false });
    expect(lines.join("\n")).toContain("this host admits no device under that key");
    // The record is left as it was: the window said what happened and opened here, and the Hosts menu still holds it.
    expect(existsSync(join(home, "hosts", "box.json"))).toBe(true);
  }, 20_000);

  it("refuses a record holding a token and no key for the host before it dials, as every line aimed at one is refused", async () => {
    writeHost(home, "box", accountRecord({ deviceToken: "tok-held", hostKey: undefined }));
    const lines: string[] = [];
    const { dial, dialled } = admittingDial({ deviceId: "d_2", deviceToken: "tok-fresh" });
    session = await openWith(dial, lines);
    expect(dialled).toEqual([]);
    expect(session).toMatchObject({ owned: true, remote: false });
    expect(lines.join("\n")).toContain(hostNoKeyLine("box"));
  }, 20_000);

  it("starts the host on a free port and serves the app with the digest of its token, never the token", async () => {
    session = await open(0, 0);
    expect(session.owned).toBe(true);
    expect(session.port).toBeGreaterThan(0);
    expect(session.url).toBe(`http://127.0.0.1:${session.port}`);
    const boot = await bootOf(session.url);
    expect(boot?.tokenHash).toMatch(DIGEST);
    expect(boot?.token).toBeUndefined();
    expect(boot?.wsPort).toBeGreaterThan(0);
  });

  it("stops the host it started when closed", async () => {
    session = await open(0, 0);
    const url = session.url;
    await session.close();
    session = undefined;
    expect(await refused(url)).toBe(true);
  });

  it("starts its own host rather than attaching to a wsp host on the port no lock beside this state file names", async () => {
    // Any login on this computer can bind a port and serve a page with the boot line in it; the lock beside the
    // state file is what says a host of the owner's is serving, and there is none here.
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
    session = await open(existing.port, 0);
    expect(session.owned).toBe(true);
    expect(session.port).not.toBe(existing.port);
    expect((await bootOf(session.url))?.tokenHash).toMatch(DIGEST);
  });

  it("falls back to free ports when the defaults are held by something else", async () => {
    const other = createServer((_req, res) => res.end("nope"));
    const port = await listen(other);
    try {
      session = await open(port, 0);
      expect(session.owned).toBe(true);
      expect(session.port).not.toBe(port);
      expect((await bootOf(session.url))?.tokenHash).toBeDefined();
    } finally {
      await closeServer(other);
    }
  });

  it("falls back to free ports when only the websocket port is taken", async () => {
    const taken = createTcpServer();
    const wsPort = await listen(taken);
    const free = createTcpServer();
    const port = await listen(free);
    await closeServer(free);
    try {
      session = await open(port, wsPort);
      expect(session.owned).toBe(true);
      const boot = await bootOf(session.url);
      expect(boot?.wsPort).not.toBe(wsPort);
    } finally {
      await closeServer(taken);
    }
  });

  it("attaches to the host named in host.lock when its page carries the digest of the token beside this state file, whatever port it was asked for, and sends that page nothing", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
    // The page passes through a recorder standing where the lock says the host is, so what the window sent to
    // settle the question is read: a squatter on that port would read the same bytes.
    const seen = await recording(existing.port);
    try {
      const lock = { pid: process.pid, port: seen.port, wsPort: existing.wsPort, startedAt: new Date().toISOString() };
      writeFileSync(join(home, "host.lock"), JSON.stringify(lock));
      writeFileSync(join(home, "host-token"), `${existing.authToken}\n`);

      session = await open(await freePort(), 0);
      expect(session.owned).toBe(false);
      expect(session.url).toBe(`http://127.0.0.1:${seen.port}`);
      await session.close();
      session = undefined;
      expect((await bootOf(`http://127.0.0.1:${existing.port}`))?.tokenHash).toBe(digestOf(existing.authToken));
      expect(JSON.parse(readFileSync(join(home, "host.lock"), "utf8"))).toEqual(lock);
      // One read of the page, carrying no bearer and no token: the compare happened here, against the file.
      expect(seen.requests.length).toBeGreaterThan(0);
      for (const r of seen.requests) {
        expect(r.authorization).toBeUndefined();
        expect(r.url).not.toContain(existing.authToken);
      }
    } finally {
      await seen.close();
    }
  });

  it("opens on a computer with no provider key, over the state file this computer is recorded in", async () => {
    // No key in any layer, and the window's io answers nothing: the road that asks for one dies here.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const statePath = join(home, "state.json");
    // The copy road alone is faked: every workspace here is a copy, and this checkout stages no daemon binary.
    const recorded = makeRuntime({}, statePath, undefined, process.env, undefined, localWiring(home, process.env, fakeDaemonStart, statePath, copyingFake()));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-lifecycle-")));
    execFileSync("git", ["init", "-q", folder]);
    const project = await recorded.projects.add({ source: folder, name: "thisbox" });
    await recorded.workspaces.create({ project: project.id, name: "thisbox" });
    await recorded.close();

    // The two steps main.ts takes, over the runtime the gate built rather than a fixture's.
    const state = await checkSetup({ statePath });
    expect(state.ready).toBe(true);
    session = await openHost({ port: 0, wsPort: 0, statePath, webDir: fakeWebDir(), io: quietIO(), ...(state.ready ? { runtime: state.runtime } : {}) });
    expect(session.owned).toBe(true);
    expect((await bootOf(session.url))?.tokenHash).toMatch(DIGEST);
    // The workspace is a copy of a folder on this computer, so the folder its commands start in is here.
    expect(existsSync(localWorkFolder(home))).toBe(true);
  });

  it("is not ready rather than failing when there is no key, no golden and no workspace", async () => {
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    // Nothing recorded: the gate answers before any host is started, so the window has a first launch to show.
    expect(await checkSetup({ statePath: join(home, "state.json") })).toEqual({ ready: false });
    // And a first launch that ends there leaves the person's home as it was: no workspace was recorded here.
    expect(existsSync(localWorkFolder(home))).toBe(false);
  });

  it("refuses a loopback lock whose page carries another token's digest than the file beside the state, or none, and starts nothing", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
    writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: existing.port, wsPort: existing.wsPort, startedAt: new Date().toISOString() }));
    writeFileSync(join(home, "host-token"), "a-token-of-some-other-host\n");
    const port = await freePort();
    await expect(open(port, 0)).rejects.toThrow(/holds .*host\.lock on port \d+ but the page it serves carries another token's digest/);
    // Nothing of this window's is on that port, and the lock is the one the other process wrote.
    expect(await portFree(port)).toBe(true);
    expect((JSON.parse(readFileSync(join(home, "host.lock"), "utf8")) as { port: number }).port).toBe(existing.port);

    // A page with the boot line and no digest at all: what a host bound beyond this computer serves, standing on a
    // loopback lock that says otherwise.
    const bare = createServer((_req, res) => res.end(`<html><script>window.__WSP__ = ${JSON.stringify({ wsPath: "/ws", paired: true, version: "0.0.0" })};</script></html>`));
    const barePort = await listen(bare);
    try {
      writeFileSync(join(home, "host-token"), `${existing.authToken}\n`);
      writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: barePort, wsPort: 0, startedAt: new Date().toISOString() }));
      await expect(open(await freePort(), 0)).rejects.toThrow(/but the page it serves carries another token's digest/);
    } finally {
      await closeServer(bare);
    }
  });

  it("refuses a loopback lock with no wsp host answering on its port, which is the stale lock a squatter took", async () => {
    const squatter = createServer((_req, res) => res.end("<html>hello</html>"));
    const port = await listen(squatter);
    try {
      writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port, wsPort: 0, startedAt: new Date().toISOString() }));
      await expect(open(await freePort(), 0)).rejects.toThrow(/but no wsp host answers there/);
    } finally {
      await closeServer(squatter);
    }
  });

  it.runIf(ipv6Loopback)("dials a loopback lock where its address says that host answers, not this computer's other loopback name", async () => {
    // A host up with --listen ::1 binds a loopback address, so its page carries its token's digest, and it answers
    // there and nowhere else.
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0, listen: "::1", statePath: join(home, "state.json") });
    writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: existing.port, wsPort: existing.wsPort, address: "::1", startedAt: new Date().toISOString() }));
    writeFileSync(join(home, "host-token"), `${existing.authToken}\n`);
    session = await open(await freePort(), 0);
    expect(session.owned).toBe(false);
    expect(session.url).toBe(`http://[::1]:${existing.port}`);
  });

  it("attaches through the lock alone to a host bound beyond this computer, whose page carries no digest by design", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0, listen: "0.0.0.0", statePath: join(home, "state.json") });
    writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: existing.port, wsPort: existing.wsPort, address: "0.0.0.0", startedAt: new Date().toISOString() }));
    // No token file is written and none is asked for: that page inlines no digest, and the lock is the whole reading.
    session = await open(await freePort(), 0);
    expect(session.owned).toBe(false);
    expect(session.url).toBe(`http://127.0.0.1:${existing.port}`);
  });

  it.runIf(process.getuid !== undefined && process.getuid() !== 0)("refuses a lock naming a process of another login, whatever answers on its port", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
    writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: 1, port: existing.port, wsPort: existing.wsPort, startedAt: new Date().toISOString() }));
    writeFileSync(join(home, "host-token"), `${existing.authToken}\n`);
    await expect(open(await freePort(), 0)).rejects.toThrow(/but that process is not this login's/);
  });

  it("ignores a host.lock whose pid is gone and starts its own host", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
    const stale = { pid: deadPid(), port: existing.port, wsPort: existing.wsPort, startedAt: "2026-09-01T00:00:00.000Z" };
    writeFileSync(join(home, "host.lock"), JSON.stringify(stale));

    session = await open(await freePort(), 0);
    expect(session.owned).toBe(true);
    expect(session.port).not.toBe(existing.port);
    const lock = JSON.parse(readFileSync(join(home, "host.lock"), "utf8")) as { pid: number; port: number };
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(session.port);
  });
});

describe("locateHost", () => {
  let user: string;
  let cwd: string;
  let existing: HostHandle | undefined;
  const alive = (h: HostHandle): string => JSON.stringify({ pid: process.pid, port: h.port, wsPort: h.wsPort, startedAt: new Date().toISOString() });

  beforeEach(() => {
    user = mkdtempSync(join(tmpdir(), "wsp-desktop-user-"));
    cwd = join(user, "cwd");
    mkdirSync(cwd);
    vi.stubEnv("HOME", user);
  });
  afterEach(async () => {
    await existing?.close();
    existing = undefined;
    vi.unstubAllEnvs();
    rmSync(user, { recursive: true, force: true });
  });

  function fixture(): Promise<HostHandle> {
    return startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
  }

  /** A home with a lock naming the fixture and the token it serves, the way a host serving it leaves things. */
  function homeServedBy(h: HostHandle, lock: string = alive(h)): string {
    const dir = mkdtempSync(join(tmpdir(), "wsp-desktop-custom-"));
    writeFileSync(join(dir, "host.lock"), lock);
    writeFileSync(join(dir, "host-token"), `${h.authToken}\n`);
    return dir;
  }

  it("finds nothing to attach to where a wsp host is on a port and no lock beside the resolved home names it", async () => {
    existing = await fixture();
    expect(await locateHost({ packaged: false, cwd })).toEqual({ home: join(user, ".wsp") });
  });

  it("names ~/.wsp with nothing to attach to when there is no host", async () => {
    expect(await locateHost({ packaged: false, cwd })).toEqual({ home: join(user, ".wsp") });
  });

  it("opens on the home WSP_HOME names, and a host serving some other home is not attached to", async () => {
    // The one way a window opens on a home somebody moved is being launched with that home named; a file under the
    // person's own home saying where a host went is a file two hosts would write.
    existing = await fixture();
    const custom = homeServedBy(existing);
    const env = join(user, "env-home");
    const found = await locateHost({ packaged: false, env, cwd });
    expect(found).toEqual({ home: env });
    expect(await locateHost({ packaged: false, env: custom, cwd })).toMatchObject({ home: custom, session: { url: `http://127.0.0.1:${existing.port}` } });
  });

  it("attaches through the lock next to the state file of the home it resolved", async () => {
    existing = await fixture();
    const env = homeServedBy(existing);
    const found = await locateHost({ packaged: false, env, cwd });
    expect(found.home).toBe(env);
    expect(found.session?.url).toBe(`http://127.0.0.1:${existing.port}`);
  });
});

describe("hostTokenMatches", () => {
  it("matches only the digest of the exact bytes of the token file beside the state, never the token itself, and nothing at all where there is no file", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-desktop-token-"));
    const statePath = join(dir, "state.json");
    try {
      expect(hostTokenMatches(statePath, digestOf("a-token"))).toBe(false);
      writeFileSync(join(dir, "host-token"), "a-token\n");
      expect(hostTokenMatches(statePath, digestOf("a-token"))).toBe(true);
      // The token in the clear is not its digest: a page carrying the token would be refused, as it should be.
      expect(hostTokenMatches(statePath, "a-token")).toBe(false);
      expect(hostTokenMatches(statePath, digestOf("a-token "))).toBe(false);
      expect(hostTokenMatches(statePath, digestOf("A-TOKEN"))).toBe(false);
      expect(hostTokenMatches(statePath, digestOf("a-toke"))).toBe(false);
      expect(hostTokenMatches(statePath, digestOf("a-token").toUpperCase())).toBe(false);
      expect(hostTokenMatches(statePath, "")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("statePathIn", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-desktop-home-"));
    cwd = mkdtempSync(join(tmpdir(), "wsp-desktop-cwd-"));
    // What makes a folder a checkout of wsp: its own root package.json naming the workspace.
    writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "wsp", private: true })}\n`);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("shares the checkout's state with wspx when a development run is launched from a checkout of wsp", () => {
    expect(statePathIn(home, { packaged: false, cwd })).toBe(join(cwd, ".wsp", "state.json"));
  });

  it("keeps a packaged app's state in the home, whatever the folder it was launched from holds", () => {
    expect(statePathIn(home, { packaged: true, cwd })).toBe(join(home, "state.json"));
  });

  it("lets WSP_HOME win over the launch folder, packaged or not, which is what the locate doc says", () => {
    for (const packaged of [true, false]) expect(statePathIn(home, { packaged, cwd, env: home })).toBe(join(home, "state.json"));
  });

  it("reads an empty WSP_HOME as none set, so a development run still shares the checkout's state", () => {
    expect(statePathIn(home, { packaged: false, cwd, env: "" })).toBe(join(cwd, ".wsp", "state.json"));
  });

  it("takes the home when the launch folder is no checkout, packaged or not", () => {
    const bare = mkdtempSync(join(tmpdir(), "wsp-desktop-bare-"));
    for (const packaged of [true, false]) expect(statePathIn(home, { packaged, cwd: bare })).toBe(join(home, "state.json"));
    rmSync(bare, { recursive: true, force: true });
  });
});

describe("userDataIn", () => {
  let user: string;
  let cwd: string;

  beforeEach(() => {
    user = mkdtempSync(join(tmpdir(), "wsp-desktop-user-"));
    cwd = join(user, "cwd");
    mkdirSync(cwd);
    vi.stubEnv("HOME", user);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(user, { recursive: true, force: true });
  });

  it("puts Chromium's files beside the state file of the home the launch names, so two apps on two homes share no profile", () => {
    const custom = join(user, "custom-home");
    expect(userDataIn({ packaged: true, cwd, env: custom })).toBe(join(custom, "desktop"));
    expect(userDataIn({ packaged: true, cwd })).toBe(join(user, ".wsp", "desktop"));
    expect(userDataIn({ packaged: true, cwd, env: custom })).not.toBe(userDataIn({ packaged: true, cwd }));
  });

  it("follows the state file a development run shares with wspx, which sits in the checkout", () => {
    writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "wsp", private: true })}\n`);
    expect(userDataIn({ packaged: false, cwd })).toBe(join(cwd, ".wsp", "desktop"));
    // WSP_HOME wins over the checkout, packaged or not, as the state file does.
    const custom = join(user, "custom-home");
    expect(userDataIn({ packaged: false, cwd, env: custom })).toBe(join(custom, "desktop"));
  });
});
