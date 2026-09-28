// SPDX-License-Identifier: AGPL-3.0-only
// What the page carries about this computer and what the JSON routes ask for:
// the loopback page carries the digest of the host's token and never the
// token, a page beyond it carries no digest, every JSON route asks for a
// token, the lock and the address lines name the address, and the runtime
// answers on the app's own port at WS_PATH. A box on a relay binds this
// computer alone and is reached down both roads at once, so there it is what a
// request carries that decides, not what the host bound.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsOffRefusal, AGENTS_ON, HERE_PLACE_ID, loopbackThreadsLine, relayedRecordRefusal, API_UNAUTHORIZED, authority, type Caller, crossOriginRefusal, DEVICE_OPS, deviceHeldRefusal, listenBeyondLoopbackLine, LOOPBACK, REQUEST_BODY_NOT_JSON, REQUEST_BODY_TOO_LARGE, REQUEST_NOT_AN_OBJECT, WILDCARD, WS_PATH, type BootPayload } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { localWiring, serve, type CliIO } from "../src/cli.js";
import { hereUrl } from "../src/pairing.js";
import { writeRelayRecord } from "../src/relay-link.js";
import { execFileSync, spawn } from "node:child_process";
import { addressLines } from "../src/host-lock.js";
import { httpProbe } from "../src/service.js";
import { hostAddress } from "../src/verbs.js";
import { ROUTE_OPS, routeRefusal, startHost, type HostHandle } from "../src/server.js";
import { SEALED_GOLDEN as GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";
import { copyingFake, createOn, fakeDaemonStart, projectOn } from "./verbs-fixture.js";

const DEV_BOOT = `<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>`;
const PAGE = `<!doctype html>
<html><head></head><body><div id="root"></div>
${DEV_BOOT}
</body></html>
`;

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const quietIO = (lines: string[] = []): CliIO => ({ log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt });

// The relay cases here start a real child and wait for it to go, which the default five seconds can miss under a
// loaded machine.
vi.setConfig({ testTimeout: 20_000 });

let dirs: string[] = [];
let handle: HostHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fakeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-listen-web-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app')\n");
  writeFileSync(join(dir, "index.html"), PAGE);
  return dir;
}

function testRuntime(): Runtime {
  const store = memoryStore();
  void store.put("goldens", copyKey("default", "default"), GOLDEN);
  return createRuntime({ backend: stubBackend(), store, adapters: {} });
}

async function up(listen?: string): Promise<{ handle: HostHandle; runtime: Runtime }> {
  const runtime = testRuntime();
  handle = await startHost({ runtime, webDir: fakeWebDir(), port: 0, wsPort: 0, ...(listen !== undefined ? { listen } : {}) });
  return { handle, runtime };
}

/** The boot object out of the page the host served, which is the one inline script it carries. */
async function bootOf(port: number, headers: Record<string, string> = {}): Promise<BootPayload> {
  const html = await (await fetch(`http://127.0.0.1:${port}/`, { headers })).text();
  const script = /<script>window\.__WSP__ = ([\s\S]*?);<\/script>/.exec(html);
  return JSON.parse(script![1]!) as BootPayload;
}

/** What the connector puts on every request it forwards, as a request that came in through the tunnel carries it. */
const THROUGH_CONNECTOR = { "cf-connecting-ip": "203.0.113.7", "cf-ray": "8e0f4a1b2c3d4e5f-BOM" };

/** A request down a raw socket, the only road that puts a header on the wire in the capitals it was written in and
 * the only one that names a Host of its own, which fetch keeps for itself. */
async function raw(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  const body = opts.body;
  return new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: { ...(body !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), ...opts.headers },
      },
      res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => (text += chunk));
        res.once("end", () => done({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.once("error", fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The same reading down that socket. */
async function rawBootOf(port: number, headers: Record<string, string>): Promise<BootPayload> {
  const { body } = await raw(port, { headers });
  return JSON.parse(/<script>window\.__WSP__ = ([\s\S]*?);<\/script>/.exec(body)![1]!) as BootPayload;
}

/** What a page's upgrade gets when this host refuses it: the socket never opens, so no frame of it is ever read. */
async function upgradeRefused(url: string, origin: string): Promise<string> {
  const ws = new WebSocket(url, { headers: { Origin: origin } });
  return new Promise<string>((done, fail) => {
    ws.once("error", (e: Error) => done(e.message));
    ws.once("open", () => {
      ws.close();
      fail(new Error(`${url} opened for a page at ${origin}`));
    });
  });
}

/** And what it gets when the host takes it: an open socket the host token authenticates, as the app's own page has. */
async function upgradeTaken(url: string, origin: string, token: string): Promise<boolean> {
  const ws = new WebSocket(url, { headers: { Origin: origin } });
  await new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  const reply = await new Promise<Record<string, unknown>>(done => {
    ws.once("message", frame => done(JSON.parse(String(frame)) as Record<string, unknown>));
    ws.send(JSON.stringify({ id: 1, op: "auth", token }));
  });
  ws.close();
  return reply["ok"] === true;
}

/** Redeems a code the way a browser does: the first frame of a socket nothing authed, over the app's own port. */
async function redeem(port: number, code: string): Promise<{ deviceToken?: string; error?: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  await new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  const reply = await new Promise<Record<string, unknown>>(done => {
    ws.once("message", raw => done(JSON.parse(String(raw)) as Record<string, unknown>));
    ws.send(JSON.stringify({ id: 1, op: "pair.redeem", code, name: "a laptop" }));
  });
  ws.close();
  return reply as { deviceToken?: string; error?: string };
}

/** A code, minted the way wsp host pair does: over a socket holding the host's own token. `here` is the code wsp
 * init mints for the browser it opens. */
async function pairCode(wsPort: number, token: string, here = false): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  await new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  const ask = (frame: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise(done => {
      ws.once("message", raw => done(JSON.parse(String(raw)) as Record<string, unknown>));
      ws.send(JSON.stringify(frame));
    });
  await ask({ id: 1, op: "auth", token });
  const issued = await ask({ id: 2, op: "pair.issue", ...(here ? { here: true } : {}) });
  ws.close();
  return issued["code"] as string;
}

const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");

describe("a host on this computer alone", () => {
  it("inlines the digest of its own token in the page, never the token, and says the page is paired", async () => {
    const { handle: h } = await up();
    const boot = await bootOf(h.port);
    expect(boot.tokenHash).toBe(digestOf(h.authToken));
    expect(boot).not.toHaveProperty("token");
    expect(JSON.stringify(boot)).not.toContain(h.authToken);
    expect(boot.paired).toBe(true);
    expect(boot.wsPath).toBe(WS_PATH);
  });

  it("answers a bare JSON route 401, since any login on this computer reaches the port, and 200 with the host's own bearer", async () => {
    const { handle: h } = await up();
    const bare = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`);
    expect(bare.status).toBe(401);
    expect((await bare.json()) as { error: string }).toEqual({ error: API_UNAUTHORIZED });
    const own = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: { authorization: `Bearer ${h.authToken}` } });
    expect(own.status).toBe(200);
  });

  it("refuses a body that is JSON but not an object in one sentence, creates nothing, and answers the next request", async () => {
    const { handle: h, runtime } = await up();
    await projectOn(runtime);
    const own = { authorization: `Bearer ${h.authToken}` };
    for (const body of ["null", "[]", "7"]) {
      const refused = await raw(h.port, { method: "POST", path: "/api/workspaces", headers: own, body });
      expect(refused.status, body).toBe(400);
      expect(JSON.parse(refused.body) as { error: string }).toEqual({ error: REQUEST_NOT_AN_OBJECT });
    }
    expect(await runtime.workspaces.list()).toEqual([]);
    const made = await raw(h.port, { method: "POST", path: "/api/workspaces", headers: own, body: JSON.stringify({ name: "after" }) });
    expect(made.status).toBe(200);
    expect((await runtime.workspaces.list()).map(w => w.name)).toEqual(["after"]);
  });

  it("answers a body past the cap and a body that is no JSON in one sentence each, never the parser's own words", async () => {
    const { handle: h, runtime } = await up();
    await projectOn(runtime);
    const own = { authorization: `Bearer ${h.authToken}` };

    const big = await raw(h.port, { method: "POST", path: "/api/workspaces", headers: own, body: JSON.stringify({ name: "x".repeat(70 * 1024) }) });
    expect(big.status).toBe(413);
    expect(JSON.parse(big.body) as { error: string }).toEqual({ error: REQUEST_BODY_TOO_LARGE });

    const unparsed = await raw(h.port, { method: "POST", path: "/api/workspaces", headers: own, body: "not json" });
    expect(unparsed.status).toBe(400);
    expect(JSON.parse(unparsed.body) as { error: string }).toEqual({ error: REQUEST_BODY_NOT_JSON });

    expect(await runtime.workspaces.list()).toEqual([]);
    const made = await raw(h.port, { method: "POST", path: "/api/workspaces", headers: own, body: JSON.stringify({ name: "after" }) });
    expect(made.status).toBe(200);
    expect((await runtime.workspaces.list()).map(w => w.name)).toEqual(["after"]);
  });

  it("reads the browser wsp init let in as the owner on the routes, and a browser wsp host pair let in as a paired computer", async () => {
    const { handle: h, runtime } = await up();
    const callers: (Caller | undefined)[] = [];
    const listing = runtime.status.list.bind(runtime.status);
    vi.spyOn(runtime.status, "list").mockImplementation(async (o, caller) => {
      callers.push(caller);
      return listing(o, caller);
    });
    const init = await redeem(h.port, await pairCode(h.wsPort, h.authToken, true));
    const byHand = await redeem(h.port, await pairCode(h.wsPort, h.authToken));
    for (const token of [init.deviceToken!, byHand.deviceToken!]) expect((await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(callers).toEqual([undefined, "paired"]);
  });

  it("serves the runtime on the app's own port at WS_PATH as well as on its own port", async () => {
    const { handle: h } = await up();
    for (const url of [`ws://127.0.0.1:${h.port}${WS_PATH}`, `ws://127.0.0.1:${h.wsPort}`]) {
      const ws = new WebSocket(url);
      await new Promise<void>((done, fail) => {
        ws.once("open", () => done());
        ws.once("error", fail);
      });
      const reply = await new Promise<Record<string, unknown>>(done => {
        ws.once("message", raw => done(JSON.parse(String(raw)) as Record<string, unknown>));
        ws.send(JSON.stringify({ id: 1, op: "auth", token: h.authToken }));
      });
      expect(reply["ok"], url).toBe(true);
      ws.close();
    }
  });
});

describe("a page at a name this host does not answer at", () => {
  it("reads no digest out of the page and nothing off the JSON routes, though it reached the loopback port", async () => {
    const { handle: h } = await up();
    const foreignHost = { Host: `evil.example:${h.port}` };
    const boot = await rawBootOf(h.port, foreignHost);
    expect(boot.tokenHash).toBeUndefined();
    expect(boot.paired).toBe(false);

    const listed = await raw(h.port, { path: "/api/workspaces", headers: foreignHost });
    expect(listed.status).toBe(401);
    expect(JSON.parse(listed.body) as { error: string }).toEqual({ error: API_UNAUTHORIZED });
  });

  it("reads every loopback name as this computer, whatever port it names, and no other name as one", async () => {
    const { handle: h } = await up();
    for (const host of [`127.0.0.1:${h.port}`, `localhost:${h.port}`, `[::1]:${h.port}`, "127.0.0.1:54321"]) {
      const boot = await rawBootOf(h.port, { Host: host });
      expect(boot.tokenHash, host).toBe(digestOf(h.authToken));
      expect(boot.paired, host).toBe(true);
    }
    // A name is never this computer, however it begins: a rebinding attacker registers what it likes.
    for (const host of [`evil.example:${h.port}`, "wsp.example", `127.evil.example:${h.port}`, `[2001:db8::5]:${h.port}`]) {
      const boot = await rawBootOf(h.port, { Host: host });
      expect(boot.tokenHash, host).toBeUndefined();
      expect(boot.paired, host).toBe(false);
    }
  });

  it("refuses its upgrade before a frame of it is read, on the app's port and on the runtime's own", async () => {
    const { handle: h } = await up();
    const foreign = `http://evil.example:${h.port}`;
    expect(await upgradeRefused(`ws://127.0.0.1:${h.port}${WS_PATH}`, foreign)).toContain("403");
    expect(await upgradeRefused(`ws://127.0.0.1:${h.wsPort}`, foreign)).toMatch(/Unexpected server response/);

    // The app's own page dials both ports from the one name it was served at, and both open as they always did.
    const own = `http://127.0.0.1:${h.port}`;
    expect(await upgradeTaken(`ws://127.0.0.1:${h.port}${WS_PATH}`, own, h.authToken)).toBe(true);
    expect(await upgradeTaken(`ws://127.0.0.1:${h.wsPort}`, own, h.authToken)).toBe(true);
  });

  it("refuses its write with one sentence and creates nothing, where the app's own page and a tool still create", async () => {
    const { handle: h, runtime } = await up();
    await projectOn(runtime);
    const body = JSON.stringify({ name: "never" });
    const refused = await raw(h.port, { method: "POST", path: "/api/workspaces", headers: { Origin: "http://evil.example" }, body });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body) as { error: string }).toEqual({ error: crossOriginRefusal("http://evil.example", `127.0.0.1:${h.port}`) });
    expect(await runtime.workspaces.list()).toEqual([]);

    // The page at the name this host answers at, and the command line, which sends no Origin at all; both carry
    // the host's own token, which is what names them.
    const own = { authorization: `Bearer ${h.authToken}` };
    const made = await raw(h.port, { method: "POST", path: "/api/workspaces", headers: { ...own, Origin: `http://127.0.0.1:${h.port}` }, body: JSON.stringify({ name: "from the page" }) });
    expect(made.status).toBe(200);
    const typed = await raw(h.port, { method: "POST", path: "/api/workspaces", headers: own, body: JSON.stringify({ name: "from a tool" }) });
    expect(typed.status).toBe(200);
    expect((await runtime.workspaces.list()).map(w => w.name)).toEqual(["from the page", "from a tool"]);
  });
});

describe("what a page carries about this computer", () => {
  /** A host serving a state file, which is the one thing the boot object names a path of. */
  async function withState(listen?: string): Promise<{ handle: HostHandle; statePath: string }> {
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-state-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    handle = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0, statePath, ...(listen !== undefined ? { listen } : {}) });
    return { handle, statePath };
  }

  it("names the state file and the runtime's port on this computer's own page, with the port first for the shell's probe", async () => {
    const { handle: h, statePath } = await withState();
    const html = await (await fetch(`http://127.0.0.1:${h.port}/`)).text();
    expect(html).toContain(`<script>window.__WSP__ = {"wsPort":${h.wsPort},`);
    const boot = await bootOf(h.port);
    expect(boot.statePath).toBe(statePath);
    expect(boot.paired).toBe(true);
  });

  it("gives a stranger the pairing screen alone: no state path and no runtime port, at a name this host does not answer at or through the connector", async () => {
    const { handle: h } = await withState();
    for (const headers of [{ Host: `evil.example:${h.port}` }, { ...THROUGH_CONNECTOR, Host: `127.0.0.1:${h.port}` }]) {
      const boot = await rawBootOf(h.port, headers);
      expect(boot.statePath, JSON.stringify(headers)).toBeUndefined();
      expect(boot.wsPort, JSON.stringify(headers)).toBeUndefined();
      expect(boot.tokenHash, JSON.stringify(headers)).toBeUndefined();
      expect(boot.paired, JSON.stringify(headers)).toBe(false);
      // The page still dials the origin it came from, which is the one road a paired device has.
      expect(boot.wsPath, JSON.stringify(headers)).toBe(WS_PATH);
    }
  });

  it("gives every page a host bound beyond this computer serves the same, its own port included", async () => {
    const { handle: h } = await withState("0.0.0.0");
    const boot = await bootOf(h.port);
    expect(boot.statePath).toBeUndefined();
    expect(boot.wsPort).toBeUndefined();
    expect(boot.paired).toBe(false);
  });
});

describe("a host that listens beyond this computer", () => {
  it("serves the page with no digest and paired false", async () => {
    const { handle: h } = await up("0.0.0.0");
    const boot = await bootOf(h.port);
    expect(boot.tokenHash).toBeUndefined();
    expect(boot.paired).toBe(false);
    expect(boot.wsPath).toBe(WS_PATH);
  });

  it("answers 401 on a JSON route with no bearer and 200 with a paired device's token", async () => {
    const { handle: h } = await up("0.0.0.0");
    const bare = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`);
    expect(bare.status).toBe(401);
    expect((await bare.json()) as { error: string }).toEqual({ error: API_UNAUTHORIZED });

    const code = await pairCode(h.wsPort, h.authToken);
    const { deviceToken } = await redeem(h.port, code);
    expect(typeof deviceToken).toBe("string");

    const withToken = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: { authorization: `Bearer ${deviceToken!}` } });
    expect(withToken.status).toBe(200);

    const wrong = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("names an unscoped device as a paired computer on the JSON routes, so the runtime reads one road down both", async () => {
    const { handle: h, runtime } = await up("0.0.0.0");
    await createOn(runtime, { golden: GOLDEN.versions[0]!.snapshotId, name: "lead" });
    const callers: (Caller | undefined)[] = [];
    const listing = runtime.status.list.bind(runtime.status);
    vi.spyOn(runtime.status, "list").mockImplementation(async (o, caller) => {
      callers.push(caller);
      return listing(o, caller);
    });

    const code = await pairCode(h.wsPort, h.authToken);
    const { deviceToken } = await redeem(h.port, code);
    const listed = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: { authorization: `Bearer ${deviceToken!}` } });
    expect(listed.status).toBe(200);
    // The listing is what it always was for that computer; what changed is the word the runtime is handed with it.
    expect(((await listed.json()) as { workspaces: { name: string }[] }).workspaces.map(w => w.name)).toEqual(["lead"]);
    expect(callers).toEqual(["paired"]);

    // The host's own token is nobody in particular, exactly as it was: the person's own road names no road.
    await h.close();
    const { handle: mine, runtime: here } = await up();
    const own: (Caller | undefined)[] = [];
    const ownList = here.status.list.bind(here.status);
    vi.spyOn(here.status, "list").mockImplementation(async (o, caller) => {
      own.push(caller);
      return ownList(o, caller);
    });
    expect((await fetch(`http://127.0.0.1:${mine.port}/api/workspaces`, { headers: { authorization: `Bearer ${mine.authToken}` } })).status).toBe(200);
    expect(own).toEqual([undefined]);
  });

  it("a paired device is held to the device list on the JSON routes by the op each route stands for, and both routes today are on it", async () => {
    const { handle: h, runtime } = await up("0.0.0.0");
    await projectOn(runtime);
    const code = await pairCode(h.wsPort, h.authToken);
    const { deviceToken } = await redeem(h.port, code);
    const auth = { authorization: `Bearer ${deviceToken!}` };
    // Both routes stand for an op a paired device may send, so both answer it.
    expect(Object.values(ROUTE_OPS).every(op => DEVICE_OPS.includes(op))).toBe(true);
    expect(ROUTE_OPS).toEqual({ "GET /api/workspaces": "status.list", "POST /api/workspaces": "workspaces.create" });
    expect((await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: auth })).status).toBe(200);
    const made = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "from a laptop" }) });
    expect(made.status).toBe(200);
    expect((await runtime.workspaces.list()).map(w => w.name)).toEqual(["from a laptop"]);
    // The door itself, read by route: nothing for a route whose op is on the list, the socket's own sentence for a
    // route with no op of its own, and nothing for the person or a thread, so a route added later is held until named.
    expect(routeRefusal("GET /api/workspaces", "paired")).toBeUndefined();
    expect(routeRefusal("POST /api/workspaces", "paired")).toBeUndefined();
    expect(routeRefusal("GET /api/nothing-here", "paired")).toBe(deviceHeldRefusal("GET /api/nothing-here"));
    expect(routeRefusal("GET /api/nothing-here", undefined)).toBeUndefined();
    expect(routeRefusal("GET /api/nothing-here", { origin: "relayed", by: { kind: "thread", threadId: "t_1", workspaceId: "ws_1", rootThreadId: "t_1" } })).toBeUndefined();
  });

  it("a JSON route with no op of its own is shut to a paired device, so a route added later is held until it names one", async () => {
    const { handle: h } = await up("0.0.0.0");
    const code = await pairCode(h.wsPort, h.authToken);
    const { deviceToken } = await redeem(h.port, code);
    const asDevice = await fetch(`http://127.0.0.1:${h.port}/api/nothing-here`, { headers: { authorization: `Bearer ${deviceToken!}` } });
    expect(asDevice.status).toBe(401);
    expect(await asDevice.json()).toEqual({ error: deviceHeldRefusal("GET /api/nothing-here") });
    // The person reads the miss the route always was.
    const asOwner = await fetch(`http://127.0.0.1:${h.port}/api/nothing-here`, { headers: { authorization: `Bearer ${h.authToken}` } });
    expect(asOwner.status).toBe(404);
  });

  it("a token scoped to a thread is that thread on the JSON routes too, not a paired computer", async () => {
    const { handle: h, runtime } = await up("0.0.0.0");
    const own = await createOn(runtime, { golden: GOLDEN.versions[0]!.snapshotId, name: "lead" });
    const thread = await runtime.devices.mint("thread abcd1234", { kind: "thread", threadId: "t_1", workspaceId: own.id, rootThreadId: "t_1" }, Date.now());
    const auth = { authorization: `Bearer ${thread.deviceToken}` };

    // The listing is the one that thread may drive: the workspace it runs on, and nothing outside its tree.
    const listed = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: auth });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { workspaces: { name: string }[] }).workspaces.map(w => w.name)).toEqual(["lead"]);

    // And the route that forks a machine is held to what that thread may do, which on a workspace with no switch
    // is nothing; a paired computer's token still forks.
    const made = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "b1" }) });
    expect(made.status).toBe(500);
    expect((await made.json()) as { error: string }).toEqual({ error: agentsOffRefusal("lead", "fork") });
    expect((await runtime.workspaces.list()).map(w => w.name)).toEqual(["lead"]);
  });

  it("a thread's token forks over the write route on the host's own road alone", async () => {
    const { handle: h, runtime } = await up("0.0.0.0");
    const project = await projectOn(runtime);
    const own = await createOn(runtime, { project: project.id, golden: GOLDEN.versions[0]!.snapshotId, name: "lead", agents: AGENTS_ON });
    const thread = await runtime.devices.mint("thread abcd1234", { kind: "thread", threadId: "t_1", workspaceId: own.id, rootThreadId: "t_1" }, Date.now());
    const auth = { authorization: `Bearer ${thread.deviceToken}`, "content-type": "application/json" };
    const post = (headers: Record<string, string>, name: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { method: "POST", headers, body: JSON.stringify({ name }) });

    // A copy of the token carried out of the machine and dialled at the address this host advertises: nobody here.
    const carried = await post({ ...auth, ...THROUGH_CONNECTOR }, "carried");
    expect(carried.status).toBe(401);
    expect((await carried.json()) as { error: string }).toEqual({ error: API_UNAUTHORIZED });
    expect((await runtime.workspaces.list()).map(w => w.name)).toEqual(["lead"]);

    // The same token over the road this host serves its own workspaces' guests on forks under that thread.
    const made = await post(auth, "builder");
    expect(made.status).toBe(200);
    expect(((await made.json()) as { workspace: { rootThreadId?: string } }).workspace.rootThreadId).toBe("t_1");

    // A device the person paired carries no scope, so the connector's road is still its own.
    const code = await pairCode(h.wsPort, h.authToken);
    const { deviceToken } = await redeem(h.port, code);
    const theirs = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: { authorization: `Bearer ${deviceToken!}`, ...THROUGH_CONNECTOR } });
    expect(theirs.status).toBe(200);
  });

  it("a thread on this computer copies over the write route as itself, and a token naming a machine's road copies nothing here", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-listen-home-"));
    dirs.push(home);
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, local: localWiring(home, process.env, fakeDaemonStart, undefined, copyingFake()) });
    handle = await startHost({ runtime, webDir: fakeWebDir(), port: 0, wsPort: 0 });
    const repo = mkdtempSync(join(tmpdir(), "wsp-listen-repo-"));
    dirs.push(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    const project = await runtime.projects.add({ source: repo, on: HERE_PLACE_ID });
    const mac = await runtime.workspaces.create({ project: project.id, name: "mac", agents: AGENTS_ON });
    const scope = { kind: "thread", threadId: "t_1", workspaceId: mac.id, rootThreadId: "t_1" } as const;
    const here = await runtime.devices.mint("thread abcd1234", scope, Date.now(), "here");
    const relayed = await runtime.devices.mint("thread efgh5678", { ...scope, threadId: "t_2", rootThreadId: "t_2" }, Date.now(), "relayed");
    const post = (token: string, name: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${handle!.port}/api/workspaces`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name, project: project.id }) });

    const made = await post(here.deviceToken, "kid");
    expect(made.status).toBe(200);
    const kid = ((await made.json()) as { workspace: { kind: string; parentThreadId?: string; rootThreadId?: string } }).workspace;
    expect(kid).toMatchObject({ kind: "local", parentThreadId: "t_1", rootThreadId: "t_1" });

    const carried = await post(relayed.deviceToken, "carried");
    expect(carried.status).toBe(500);
    expect(await carried.json()).toEqual({ error: relayedRecordRefusal("carried") });
    expect((await runtime.workspaces.list()).map(w => w.name).sort()).toEqual(["kid", "mac"]);
  });

  it("a thread's token is refused over the write route from an address of this computer that is not loopback", async ctx => {
    // The half of the road rule the connector's headers cannot prove: the peer's own address. A machine whose only
    // interface is loopback has nowhere else to dial from, and says so rather than reading as a case that ran.
    const beyond = Object.values(networkInterfaces())
      .flatMap(rows => rows ?? [])
      .find(row => row.family === "IPv4" && !row.internal)?.address;
    // skip() throws, so the return below is only what tells the compiler the address is one from here on.
    if (beyond === undefined) {
      ctx.skip();
      return;
    }
    const { handle: h, runtime } = await up(WILDCARD);
    const project = await projectOn(runtime);
    const own = await createOn(runtime, { project: project.id, golden: GOLDEN.versions[0]!.snapshotId, name: "lead", agents: AGENTS_ON });
    const thread = await runtime.devices.mint("thread abcd1234", { kind: "thread", threadId: "t_1", workspaceId: own.id, rootThreadId: "t_1" }, Date.now());
    const auth = { authorization: `Bearer ${thread.deviceToken}`, "content-type": "application/json" };
    const made = await fetch(`http://${authority(beyond, h.port)}/api/workspaces`, { method: "POST", headers: auth, body: JSON.stringify({ name: "from the wire" }) });
    expect(made.status).toBe(401);
    expect((await made.json()) as { error: string }).toEqual({ error: API_UNAUTHORIZED });
    expect((await runtime.workspaces.list()).map(w => w.name)).toEqual(["lead"]);
    // The same token at this host's own loopback forks, so what refused the one above is the road and not the token.
    const here = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { method: "POST", headers: auth, body: JSON.stringify({ name: "builder" }) });
    expect(here.status).toBe(200);
  });

  it("pairs whatever a request carries, since the connector's headers are not what opened that road", async () => {
    const { handle: h } = await up("0.0.0.0");
    for (const headers of [{}, THROUGH_CONNECTOR]) {
      const boot = await bootOf(h.port, headers);
      expect(boot.tokenHash).toBeUndefined();
      expect(boot.paired).toBe(false);
    }
  });

  it("still serves the page and its assets to anyone who reaches the port, since pairing is the gate", async () => {
    const { handle: h } = await up("0.0.0.0");
    expect((await fetch(`http://127.0.0.1:${h.port}/`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${h.port}/assets/app.js`)).status).toBe(200);
  });
});

describe("the address every reading names", () => {
  it("addressLines names the bound address, and a reading with none means this computer alone", () => {
    expect(addressLines("/s/state.json", { port: 4400, wsPort: 4410, address: "0.0.0.0" })[0]).toBe("app         http://0.0.0.0:4400");
    expect(addressLines("/s/state.json", { port: 4400, wsPort: 4410 })[0]).toBe(`app         http://${LOOPBACK}:4400`);
  });

  it("addressLines spells an IPv6 address the way every other line does, through the one authority rule", () => {
    const lines = addressLines("/s/state.json", { port: 4400, wsPort: 4410, address: "2001:db8::5" });
    expect(lines[0]).toBe("app         http://[2001:db8::5]:4400");
    expect(lines[1]).toContain("ws://[2001:db8::5]:4410");
  });

  it("says once, as it starts, that the page is now reachable and pairing is the gate", () => {
    expect(listenBeyondLoopbackLine("0.0.0.0")).toContain("wsp host pair");
  });
});

describe("where a thread on this computer dials this host", () => {
  it("is the runtime socket's own port on loopback, one value the guest door and a turn's launch both read", async () => {
    const cell: { url?: string } = {};
    handle = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0, here: cell });
    expect(cell.url).toBe(`http://${LOOPBACK}:${handle.wsPort}`);
    await handle.close();
    handle = undefined;
    // The wildcard answers on loopback too, so a host bound to it is dialled there.
    const wild: { url?: string } = {};
    handle = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0, listen: WILDCARD, here: wild });
    expect(wild.url).toBe(`http://${LOOPBACK}:${handle.wsPort}`);
  });

  it("is nothing on a host bound to one address beyond loopback, which says so as it starts", async ctx => {
    expect(hereUrl("192.168.1.20", 4801)).toBeUndefined();
    expect(hereUrl("::1", 4801)).toBe("http://[::1]:4801");
    expect(hereUrl("::", 4801)).toBe(`http://${LOOPBACK}:4801`);
    expect(loopbackThreadsLine("192.168.1.20")).toContain("loopback");
    const beyond = Object.values(networkInterfaces())
      .flatMap(rows => rows ?? [])
      .find(row => row.family === "IPv4" && !row.internal)?.address;
    if (beyond === undefined) {
      ctx.skip();
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-beyond-"));
    dirs.push(dir);
    const cell: { url?: string } = {};
    const lines: string[] = [];
    handle = await serve(quietIO(lines), { port: 0, wsPort: 0, address: beyond, statePath: join(dir, "state.json"), webDir: fakeWebDir(), runtime: testRuntime(), here: cell });
    expect(cell.url).toBeUndefined();
    expect(lines).toContain(loopbackThreadsLine(beyond));
  });
});

describe("where a tool on this computer dials", () => {
  it("reads the address out of the lock, so a host on one named address is reachable and not assumed loopback", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-dial-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    writeFileSync(join(dir, "host-token"), "a-token");
    const lock = (address?: string): void =>
      writeFileSync(join(dir, "host.lock"), JSON.stringify({ pid: process.pid, port: 4400, wsPort: 4410, startedAt: new Date().toISOString(), ...(address !== undefined ? { address } : {}) }));

    lock("100.64.0.3");
    expect(hostAddress(statePath)).toEqual({ url: "ws://100.64.0.3:4410", token: "a-token" });
    lock("::1");
    expect(hostAddress(statePath).url).toBe("ws://[::1]:4410");
    lock("0.0.0.0");
    expect(hostAddress(statePath).url).toBe(`ws://${LOOPBACK}:4410`);
    lock();
    expect(hostAddress(statePath).url).toBe(`ws://${LOOPBACK}:4410`);
  });
});

describe("the probe wsp status and wsp up --service wait on", () => {
  it("asks the address the lock names, so a host on one named address does not read as dead", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const lock = (address?: string) => ({ pid: process.pid, port: 4401, wsPort: 4411, startedAt: "", ...(address !== undefined ? { address } : {}) });
      expect(await httpProbe(lock("172.17.0.2"))).toBe(true);
      expect(await httpProbe(lock("::1"))).toBe(true);
      expect(await httpProbe(lock("0.0.0.0"))).toBe(true);
      expect(await httpProbe(lock())).toBe(true);
      expect(seen).toEqual(["http://172.17.0.2:4401/", "http://[::1]:4401/", `http://${LOOPBACK}:4401/`, `http://${LOOPBACK}:4401/`]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the lock the host writes", () => {
  it("records the address it bound so wsp status and wsp host pair read it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-state-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const runtime = testRuntime();
    handle = await serve(quietIO(), { port: 0, wsPort: 0, address: "0.0.0.0", statePath, webDir: fakeWebDir(), runtime });
    const lock = JSON.parse(readFileSync(join(dir, "host.lock"), "utf8")) as { address?: string; port: number; wsPort: number };
    expect(lock.address).toBe("0.0.0.0");
    expect(addressLines(statePath, lock)[0]).toBe(`app         http://0.0.0.0:${lock.port}`);
  });
});

describe("a host on loopback that a relay carries traffic to", () => {
  /** A linked box serving its own loopback port, with the relay itself off: what decides here is what a request
   * carries, not whether the tunnel is up. */
  async function linkedBox(tag: string): Promise<{ h: HostHandle; lines: string[]; runtime: Runtime }> {
    const dir = mkdtempSync(join(tmpdir(), `wsp-listen-${tag}-`));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    writeRelayRecord(statePath, { relayUrl: "http://127.0.0.1:1", hostId: "h1", token: "relay-token", name: "box", linkedAt: new Date().toISOString() });
    const lines: string[] = [];
    const runtime = testRuntime();
    handle = await serve(quietIO(lines), { port: 0, wsPort: 0, statePath, webDir: fakeWebDir(), runtime });
    return { h: handle, lines, runtime };
  }

  it("serves its own computer's app the token's digest in the page, exactly as it did before it was linked", async () => {
    const { h } = await linkedBox("relay-here");
    const boot = await bootOf(h.port);
    expect(boot.tokenHash).toBe(digestOf(h.authToken));
    expect(boot.paired).toBe(true);
    expect((await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: { authorization: `Bearer ${h.authToken}` } })).status).toBe(200);
  });

  it("takes the pairing road on a request the connector forwarded, and the local road on one it did not, down the one port", async () => {
    const { h } = await linkedBox("relay-through");
    const port = h.port;

    // Both readings on the one host, since telling them apart is the whole of what this does: a host that answers
    // the same way to both has no rule at all.
    const forwarded = await bootOf(port, THROUGH_CONNECTOR);
    expect(forwarded.tokenHash).toBeUndefined();
    expect(forwarded.paired).toBe(false);
    expect((await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers: THROUGH_CONNECTOR })).status).toBe(401);

    const local = await bootOf(port);
    expect(local.tokenHash).toBe(digestOf(h.authToken));
    expect(local.paired).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers: { authorization: `Bearer ${h.authToken}` } })).status).toBe(200);

    // The one road in for the forwarded request still works: a code from the host's own terminal buys a device token.
    const code = await pairCode(h.wsPort, h.authToken);
    const redeemed = await redeem(port, code);
    expect(redeemed.deviceToken).toMatch(/\S/);
    const authed = await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers: { ...THROUGH_CONNECTOR, authorization: `Bearer ${redeemed.deviceToken!}` } });
    expect(authed.status).toBe(200);
  });

  it("takes a page at the relay's own name, which is the name that host was reached at, and no other", async () => {
    const { h, runtime } = await linkedBox("relay-origin");
    await projectOn(runtime);
    const code = await pairCode(h.wsPort, h.authToken);
    const { deviceToken } = await redeem(h.port, code);
    const relayed = { ...THROUGH_CONNECTOR, Host: "h1.boxes.example", authorization: `Bearer ${deviceToken!}` };

    const made = await raw(h.port, { method: "POST", path: "/api/workspaces", headers: { ...relayed, Origin: "https://h1.boxes.example" }, body: JSON.stringify({ name: "over the relay" }) });
    expect(made.status).toBe(200);

    const refused = await raw(h.port, { method: "POST", path: "/api/workspaces", headers: { ...relayed, Origin: "https://evil.example" }, body: JSON.stringify({ name: "never" }) });
    expect(refused.status).toBe(403);
    expect((await runtime.workspaces.list()).map(w => w.name)).toEqual(["over the relay"]);
  });

  it("says at start which requests pair and which open as before", async () => {
    const { lines } = await linkedBox("relay-said");
    expect(lines.join("\n")).toContain("through the relay");
  });

  it("still opens its own door for a computer on this network, which the relay is no road to", async () => {
    const { h } = await linkedBox("relay-door");
    const view = await h.door.open();
    expect(h.door.port()).toBeDefined();
    expect(view.port).toBe(h.door.port());
    expect(view.port).not.toBe(h.port);
  });

  it("reads either of the connector's two headers, in the capitals cloudflared writes them", async () => {
    const { h } = await linkedBox("relay-half");
    // Written the way the connector writes them and sent down a raw socket, since fetch lowercases what it is given
    // and this host's reading has to hold for what actually arrives.
    for (const header of [["Cf-Connecting-Ip", "203.0.113.7"], ["Cf-Ray", "8e0f4a1b2c3d4e5f-BOM"]] as const) {
      const boot = await rawBootOf(h.port, { [header[0]]: header[1] });
      expect(boot.tokenHash, header[0]).toBeUndefined();
      expect(boot.paired, header[0]).toBe(false);
    }
  });
});

describe("wsp up --no-relay on a linked box", () => {
  it("serves its own computer the token's digest, and stops the connector an earlier run left running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-norelay-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    writeRelayRecord(statePath, { relayUrl: "http://127.0.0.1:1", hostId: "h1", token: "relay-token", name: "box", hostname: "h1.boxes.example", linkedAt: new Date().toISOString() });
    // A connector from a run that was killed: the tunnel it carries reaches this port whatever this run was asked for.
    const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    writeFileSync(join(dir, "connector.pid"), JSON.stringify({ pid: orphan.pid, startedAt: new Date().toISOString() }));
    const gone = new Promise<void>(done => orphan.once("exit", () => done()));

    handle = await serve(quietIO(), { port: 0, wsPort: 0, statePath, webDir: fakeWebDir(), runtime: testRuntime(), relay: false });

    const boot = await bootOf(handle.port);
    expect(boot.tokenHash).toBe(digestOf(handle.authToken));
    expect(boot.paired).toBe(true);
    expect((await fetch(`http://127.0.0.1:${handle.port}/api/workspaces`, { headers: THROUGH_CONNECTOR })).status).toBe(401);
    await gone;
    expect(existsSync(join(dir, "connector.pid"))).toBe(false);
  });
});
