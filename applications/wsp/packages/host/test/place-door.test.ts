// SPDX-License-Identifier: AGPL-3.0-only
// The door a computer somebody owns dials: a second listener on the wildcard,
// the same page with no token in it, the same runtime behind it, and the one
// port a place file can name for good.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { freshEphemeral } from "@wsp/keys";
import { AGENTS_ON, API_UNAUTHORIZED, DEFAULT_PLACE_PORT, DEFAULT_PORT, LOOPBACK, PLACE_LINK_NONCE_BYTES, PLACE_PORT_OFFSET, SCOPED_TOKEN_ROAD_REFUSAL, WILDCARD, WS_PATH, doorPortHeldLine, type BootPayload } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, newPlaceKeyPair, type PlaceBackHolder, type Runtime } from "@wsp/runtime";
import { WsClient } from "../../runtime/test/ws-client.js";
import { placeWiring } from "../src/places.js";
import { startHost, type HostHandle } from "../src/server.js";
import { SEALED_GOLDEN as GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";
import { createOn, projectOn } from "./verbs-fixture.js";

const DEV_BOOT = `<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>`;
const PAGE = `<!doctype html>\n<html><body><div id="root"></div>\n${DEV_BOOT}\n</body></html>\n`;

let dirs: string[] = [];
let handle: HostHandle | undefined;
let held: Server | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await letGo(held);
  held = undefined;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fakeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-door-web-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), PAGE);
  return dir;
}

function testRuntime(): Runtime {
  const store = memoryStore();
  void store.put("goldens", copyKey("default", "default"), GOLDEN);
  const state = mkdtempSync(join(tmpdir(), "wsp-door-state-"));
  dirs.push(state);
  return createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: placeWiring(join(state, "state.json")) });
}

/** Holds a port the way the door holds one: the wildcard, since a loopback bind and a wildcard bind on the same
 * port are a clash on Linux and are not one on macOS, and this test must read the same on both. */
const hold = (port: number, address: string = WILDCARD): Promise<Server | undefined> =>
  new Promise(done => {
    const server = createServer((_req, res) => res.end("mine"));
    server.once("error", () => done(undefined));
    server.listen(port, address, () => done(server));
  });

const letGo = (server: Server | undefined): Promise<void> => (server === undefined ? Promise.resolve() : new Promise(done => server.close(() => done())));

/** Below every operating system's ephemeral range (macOS from 49152, Linux from 32768), so no socket another process
 * opens is handed either port of the pair between the probe and the host's bind. */
const PAIR_BAND = { from: 20_000, to: 32_000 };

/** An app port whose door port is free too: the door's own is the app's plus the offset and neither is stepped over,
 * so a pair is picked here rather than left to whatever the operating system hands back. Both are probed on the
 * address their real listener binds, so a port this answers for is one both listeners can have. */
async function freePair(): Promise<number> {
  for (let tries = 0; tries < 20; tries += 1) {
    const port = PAIR_BAND.from + Math.floor(Math.random() * (PAIR_BAND.to - PLACE_PORT_OFFSET - PAIR_BAND.from));
    const own = await hold(port, LOOPBACK);
    await letGo(own);
    if (own === undefined) continue;
    const beside = await hold(port + PLACE_PORT_OFFSET);
    await letGo(beside);
    const besideLoopback = await hold(port + PLACE_PORT_OFFSET, LOOPBACK);
    await letGo(besideLoopback);
    if (beside !== undefined && besideLoopback !== undefined) return port;
  }
  throw new Error("no free app port whose door port is free beside it");
}

/** A host on a pair freePair picked, and on a fresh pair when another process takes the app port between the probe
 * and the bind; `first` runs on each pair before the host starts. */
async function up(opts: { door?: "closed" | "open"; listen?: string; runtime?: Runtime; back?: PlaceBackHolder } = {}, first?: (port: number) => Promise<void>): Promise<HostHandle> {
  const runtime = opts.runtime ?? testRuntime();
  for (let tries = 0; ; tries += 1) {
    const port = await freePair();
    await first?.(port);
    try {
      handle = await startHost({
        runtime,
        webDir: fakeWebDir(),
        port,
        wsPort: 0,
        ...(opts.door !== undefined ? { door: opts.door } : {}),
        ...(opts.listen !== undefined ? { listen: opts.listen } : {}),
        ...(opts.back !== undefined ? { back: opts.back } : {}),
      });
      return handle;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || tries >= 4) throw e;
      await letGo(held);
      held = undefined;
    }
  }
}

/** The boot object out of the page a port served, which is the one inline script it carries. */
async function bootOf(port: number): Promise<BootPayload> {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  return JSON.parse(/<script>window\.__WSP__ = ([\s\S]*?);<\/script>/.exec(html)![1]!) as BootPayload;
}

describe("the door a host opens for computers you own", () => {
  it("sits the offset above the app port, serves the page with no digest on it, and keeps the token's digest on the loopback page", async () => {
    const h = await up({ door: "open" });
    const port = h.port;
    expect(h.door.port()).toBe(port + PLACE_PORT_OFFSET);
    expect(DEFAULT_PLACE_PORT).toBe(DEFAULT_PORT + PLACE_PORT_OFFSET);
    const door = await bootOf(port + PLACE_PORT_OFFSET);
    expect(door.tokenHash).toBeUndefined();
    expect(door.paired).toBe(false);
    const own = await bootOf(port);
    expect(own.tokenHash).toBe(createHash("sha256").update(h.authToken).digest("hex"));
    expect(own.paired).toBe(true);
  });

  it("asks a request on the door for a paired device's token and reaches the one runtime over its own port", async () => {
    const h = await up({ door: "open" });
    const port = h.port;
    const refused = await fetch(`http://127.0.0.1:${port + PLACE_PORT_OFFSET}/api/workspaces`);
    expect(refused.status).toBe(401);
    expect((await refused.json()).error).toBe(API_UNAUTHORIZED);
    // The same route on the person's own port asks for a token too, and takes the host's own off the file beside
    // the state: reaching a loopback port is not being the person.
    expect((await fetch(`http://127.0.0.1:${port}/api/workspaces`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers: { authorization: `Bearer ${h.authToken}` } })).status).toBe(200);
    const ws = new WebSocket(`ws://127.0.0.1:${port + PLACE_PORT_OFFSET}${WS_PATH}`);
    await new Promise<void>((done, fail) => {
      ws.once("open", () => done());
      ws.once("error", fail);
    });
    ws.close();
  });

  it("opens none until it is asked, then answers the same view twice, since the place file names the port for good", async () => {
    const h = await up();
    const port = h.port;
    expect(h.door.port()).toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${port + PLACE_PORT_OFFSET}/`)).rejects.toThrow();
    const first = await h.door.open();
    const second = await h.door.open();
    expect(first).toEqual(second);
    expect(first.port).toBe(port + PLACE_PORT_OFFSET);
    expect(first.addresses.every(at => at.endsWith(`:${port + PLACE_PORT_OFFSET}`))).toBe(true);
    // The door's own listener is what a forward over ssh from a box may land on.
    expect(first.backPort).toBe(port + PLACE_PORT_OFFSET);
  });

  it("says who holds the port rather than stepping to a free one", async () => {
    const h = await up({}, async at => void (held = await hold(at + PLACE_PORT_OFFSET)));
    const port = h.port;
    expect(held).toBeDefined();
    await expect(h.door.open()).rejects.toThrow(doorPortHeldLine(port + PLACE_PORT_OFFSET));
  });

  it("opens none on a host that already answers beyond this computer, and names that host's own port instead", async () => {
    const h = await up({ listen: "0.0.0.0" });
    const view = await h.door.open();
    expect(h.door.port()).toBeUndefined();
    expect(view.port).toBe(h.port);
    expect(view.addresses.every(at => at.endsWith(`:${h.port}`))).toBe(true);
    // A forward into this host's main port would arrive from its loopback, which is the owner's own road: none.
    expect(view.backPort).toBeUndefined();
  });
});

describe("the door a forward back from a box lands on", () => {
  /** A holder that keeps the door it was handed and nothing else. */
  const doorKept = (): { back: PlaceBackHolder; door: () => Promise<number | undefined>; closed: () => boolean } => {
    let door: (() => Promise<number | undefined>) | undefined;
    let closed = false;
    return {
      back: { hold: async (_login, back) => back, release: () => {}, door: at => void (door = at), close: () => void (closed = true) },
      door: () => door!(),
      closed: () => closed,
    };
  };

  it("is the door's own listener as it stands, read at each ask", async () => {
    const kept = doorKept();
    const { port } = await up({ back: kept.back });
    expect(await kept.door()).toBe(port + PLACE_PORT_OFFSET);
    await handle!.door.close();
    expect(await kept.door()).toBe(port + PLACE_PORT_OFFSET);
  });

  it("refuses a door port another program holds on this computer's loopback, so no forward lands on that program", async () => {
    const kept = doorKept();
    const h = await up({ back: kept.back }, async at => void (held = await hold(at + PLACE_PORT_OFFSET, LOOPBACK)));
    const port = h.port;
    expect(held).toBeDefined();
    await expect(h.door.open()).rejects.toThrow(doorPortHeldLine(port + PLACE_PORT_OFFSET));
    await expect(kept.door()).rejects.toThrow(doorPortHeldLine(port + PLACE_PORT_OFFSET));
    expect(h.door.port()).toBeUndefined();
    expect(await (await fetch(`http://${LOOPBACK}:${port + PLACE_PORT_OFFSET}/`)).text()).toBe("mine");
  });

  it("is nothing on a host with no door of its own, whose main port a forward would land on", async () => {
    const kept = doorKept();
    await up({ listen: "0.0.0.0", back: kept.back });
    expect(await kept.door()).toBeUndefined();
  });

  it("lets every forward go before the door closes with the host", async () => {
    const kept = doorKept();
    const h = await up({ back: kept.back });
    await h.close();
    handle = undefined;
    expect(kept.closed()).toBe(true);
  });
});

describe("a request that arrives on the door", () => {
  /** A thread's token on a workspace that may fork, which is what a copy carried out of a machine would hold. */
  async function threadToken(runtime: Runtime): Promise<string> {
    const project = await projectOn(runtime);
    const own = await createOn(runtime, { project: project.id, golden: GOLDEN.versions[0]!.snapshotId, name: "lead", agents: AGENTS_ON });
    const minted = await runtime.devices.mint("thread abcd1234", { kind: "thread", threadId: "t_1", workspaceId: own.id, rootThreadId: "t_1" }, Date.now());
    return minted.deviceToken;
  }

  // A reverse forward lands on the door from the loopback, so the peer's address says nothing about the road.
  it("refuses a thread's token on the socket from 127.0.0.1, and the owner's own port still takes it", async () => {
    const runtime = testRuntime();
    const { port } = await up({ door: "open", runtime });
    const token = await threadToken(runtime);
    const carried = await WsClient.connectTo(`ws://127.0.0.1:${port + PLACE_PORT_OFFSET}${WS_PATH}`);
    const refused = await carried.request("auth", { token });
    expect(refused["ok"]).toBe(false);
    expect(refused["error"]).toBe(SCOPED_TOKEN_ROAD_REFUSAL);
    expect(await carried.closed()).toBe(4401);
    const own = await WsClient.connectTo(`ws://127.0.0.1:${port}${WS_PATH}`, { token });
    expect(((await own.request("workspaces.list"))["workspaces"] as { name: string }[]).map(w => w.name)).toEqual(["lead"]);
    own.close();
  });

  it("refuses a thread's token on the fork route from 127.0.0.1, and the owner's own port still forks with it", async () => {
    const runtime = testRuntime();
    const { port } = await up({ door: "open", runtime });
    const token = await threadToken(runtime);
    const post = (at: number, name: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${at}/api/workspaces`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const carried = await post(port + PLACE_PORT_OFFSET, "carried");
    expect(carried.status).toBe(401);
    expect((await carried.json()) as { error: string }).toEqual({ error: API_UNAUTHORIZED });
    expect((await runtime.workspaces.list()).map(w => w.name)).toEqual(["lead"]);
    const made = await post(port, "builder");
    expect(made.status).toBe(200);
    expect(((await made.json()) as { workspace: { rootThreadId?: string } }).workspace.rootThreadId).toBe("t_1");
  });

  it("ends every socket the door let in when it closes, and opens again after", async () => {
    const h = await up({ door: "open" });
    const at = h.door.port()!;
    const early = await WsClient.connectTo(`ws://127.0.0.1:${at}${WS_PATH}`);
    const ended = early.closed();
    const closing = h.door.close();
    await h.door.open();
    const late = await WsClient.connectTo(`ws://127.0.0.1:${at}${WS_PATH}`);
    await h.door.close();
    await closing;
    await ended;
    await late.closed();
    expect(h.door.port()).toBeUndefined();
  });

  it("names a joining computer by the address the connector carried, and never by one a box on the door wrote", async () => {
    const runtime = testRuntime();
    const seen: string[] = [];
    const door = runtime.places!;
    const join = door.join.bind(door);
    door.join = (req, from, now) => {
      seen.push(from);
      return join(req, from, now);
    };
    const { port } = await up({ door: "open", runtime });
    const joinFrom = async (at: number, headers: Record<string, string>): Promise<void> => {
      const joining = await WsClient.connectTo(`ws://127.0.0.1:${at}${WS_PATH}`, { headers });
      await joining.request("place.join", { publicKey: newPlaceKeyPair().publicKey, nonce: randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64"), ephemeral: freshEphemeral().publicKey });
      joining.close();
    };
    await joinFrom(port, { "cf-connecting-ip": "203.0.113.7", "cf-ray": "8e0f4a1b2c3d4e5f-BOM" });
    await joinFrom(port, { "cf-connecting-ip": "2001:db8::7" });
    // A reverse forward from a box lands on the door from the loopback, and the box writes every header it sends.
    await joinFrom(port + PLACE_PORT_OFFSET, { "cf-connecting-ip": "203.0.113.9" });
    await joinFrom(port, { "cf-connecting-ip": "evil.example dials in" });
    expect(seen).toEqual(["203.0.113.7", "2001:db8::7", "127.0.0.1", "127.0.0.1"]);
  });

  it("still answers the door's own ops from 127.0.0.1: a pairing code, a join and a place's dial back", async () => {
    const runtime = testRuntime();
    const { port } = await up({ door: "open", runtime });
    const door = `ws://127.0.0.1:${port + PLACE_PORT_OFFSET}${WS_PATH}`;
    const nonce = (): string => randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");

    const code = await runtime.devices.issue({ now: Date.now(), ttlMs: 60_000 });
    const pairing = await WsClient.connectTo(door);
    const redeemed = await pairing.request("pair.redeem", { code: code.code, name: "a computer of the person's" });
    expect(redeemed["ok"], String(redeemed["error"])).toBe(true);
    pairing.close();

    const joining = await WsClient.connectTo(door);
    const joined = await joining.request("place.join", { publicKey: newPlaceKeyPair().publicKey, nonce: nonce(), ephemeral: freshEphemeral().publicKey });
    expect(joined["ok"], String(joined["error"])).toBe(true);
    expect(typeof joined["hostPublicKey"]).toBe("string");
    joining.close();

    // A place this host holds no record of gets the door's own signed sentence, not the road's refusal.
    const dialling = await WsClient.connectTo(door);
    const dialled = await dialling.request("place.auth", { placeId: "p_nobody", nonce: nonce(), ephemeral: freshEphemeral().publicKey });
    expect(dialled["ok"]).toBe(false);
    expect(dialled["error"]).not.toBe(SCOPED_TOKEN_ROAD_REFUSAL);
    expect(typeof dialled["signature"]).toBe("string");
    dialling.close();
  });
});
