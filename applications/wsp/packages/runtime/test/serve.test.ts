import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import WebSocket from "ws";
import { keyFingerprint } from "@wsp/engine";
import { DAEMON_AUTH_DEADLINE_PASSED, DAEMON_PRE_AUTH_BYTES_EXCEEDED, DOCTOR_UNSERVED, REQUEST_NOT_AN_OBJECT, doctorRowRefusal, doctorRunningLine, HERE_PLACE_ID, HOST_STOPPING_CLOSE, noSuchPlaceRefusal, PLACE_LINK_NONCE_BYTES, placeLinkTranscript, SEAL_CLIENT, SEAL_UNSERVED, SealOpenReply, WS_PATH, type AdapterEvent, type DoctorLineEvent, type ForwardEvent, type InitJob, type PortForward, type TurnResult } from "@wsp/protocol";
import { copyKey, createRuntime, type HarnessAdapterFactory, type HarnessSession, type HarnessStartOptions, type InitDoor, type Runtime } from "../src/runtime.js";
import { newPlaceKeyPair, verifyPlaceBytes, type PlaceKeyPair, type PlaceRecord } from "../src/places.js";
import { freshEphemeral, makeSeal, sealKeys, sharedSecret } from "@wsp/keys";
import { serveRuntime, type ForwardsSource, type PlaceDoctor, type RuntimeServer } from "../src/serve.js";
import { daemonTokenFor } from "../src/daemon-token.js";
import { memoryStore } from "../src/store.js";
import { WsClient, createOverWire } from "./ws-client.js";
import { abortedCall, stubBackend, tokenGuest, type StubBackend } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { until } from "./until.js";

let srv: RuntimeServer | undefined;
/** The one runtime a case here builds with records of its own, closed beside the server it was served on. */
let doctorRt: Runtime | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  await doctorRt?.close();
  doctorRt = undefined;
});

function rt() {
  return createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
}

const DAEMON_TOKEN = "cafef00d".repeat(3);

describe("serveRuntime auth", () => {
  it("closes 4401 on a wrong auth token", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port);
    void c.request("auth", { token: "wrong" });
    expect(await c.closed()).toBe(4401);
  });

  it("a stop closes every client on the host-stopping code, not by cutting the socket under it", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port);
    await c.request("auth", { token: "secret" });
    const closed = c.closed();
    await srv.close();
    srv = undefined;
    expect(await closed).toBe(HOST_STOPPING_CLOSE);
  });

  it("closes 4401 when the first op is not auth", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port);
    void c.request("workspaces.list");
    expect(await c.closed()).toBe(4401);
  });

  it("rejects malformed ops on an authed socket without closing it", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const bad = await c.request("workspaces.create", {}); // missing golden+name
    expect(bad.ok).toBe(false);
    const ok = await c.request("workspaces.list");
    expect(ok.ok).toBe(true);
    c.close();
  });
});

describe("a frame that parsed as JSON but not as an object", () => {
  /** Every JSON value that is not an object, as the four raw bytes `null` and their kin arrive on the wire. */
  const BARE = ["null", "7", '"a string"', "true", "[]"];

  it("before auth is refused in one sentence under a null id and the socket closes, and the host answers the next socket", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const stranger = await WsClient.connect(srv.port);
    const frames: unknown[] = [];
    stranger.onFrame(m => frames.push(m));
    stranger.ws.send("null");
    expect(await stranger.closed()).toBe(4401);
    expect(frames).toEqual([{ id: null, ok: false, error: REQUEST_NOT_AN_OBJECT }]);
    const owner = await WsClient.connect(srv.port, { token: "secret" });
    expect((await owner.request("workspaces.list")).ok).toBe(true);
    owner.close();
  });

  it("on the owner's socket is refused the same way and the socket stays, answering the request after it", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const owner = await WsClient.connect(srv.port, { token: "secret" });
    const frames: unknown[] = [];
    owner.onFrame(m => frames.push(m));
    for (const raw of BARE) owner.ws.send(raw);
    expect((await owner.request("workspaces.list")).ok).toBe(true);
    expect(frames.slice(0, BARE.length)).toEqual(BARE.map(() => ({ id: null, ok: false, error: REQUEST_NOT_AN_OBJECT })));
    owner.close();
  });
});

describe("a frame wrong at the wire rather than at the JSON", () => {
  /** A socket upgraded by hand, so the bytes after the handshake can be anything: the client library masks every
   * frame it sends, and this case needs one it never would. */
  const upgradedByHand = async (port: number): Promise<Socket> => {
    const sock = connect(port, "127.0.0.1");
    sock.on("error", () => {});
    await once(sock, "connect");
    const answered = new Promise<string>(resolve => {
      let head = "";
      const read = (chunk: Buffer): void => {
        head += chunk.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        sock.off("data", read);
        resolve(head);
      };
      sock.on("data", read);
    });
    sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    expect((await answered).startsWith("HTTP/1.1 101 ")).toBe(true);
    return sock;
  };

  it("is said in one line naming the peer, the socket is dropped, and the host answers the next socket", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sock = await upgradedByHand(srv.port);
      const closed = new Promise<void>(resolve => sock.once("close", () => resolve()));
      // The four bytes of null as a text frame with its mask bit clear: refused at the wire, before any JSON is read.
      sock.write(Buffer.from([0x81, 0x04, 0x6e, 0x75, 0x6c, 0x6c]));
      await closed;
      expect(warn.mock.calls.map(c => String(c[0]))).toEqual(["socket from 127.0.0.1 dropped on a wire fault: Invalid WebSocket frame: MASK must be set"]);
      const owner = await WsClient.connect(srv.port, { token: "secret" });
      expect((await owner.request("workspaces.list")).ok).toBe(true);
      owner.close();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the two limits a socket is held to before it is let in", () => {
  /** A socket opened by hand, since these cases read the close code and the sentence that came with it. */
  const opened = async (port: number): Promise<{ ws: WebSocket; frames: unknown[]; closed: Promise<[number, string]> }> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const frames: unknown[] = [];
    ws.on("message", raw => frames.push(JSON.parse(String(raw))));
    const closed = new Promise<[number, string]>(resolve => ws.once("close", (code, reason) => resolve([code, String(reason)])));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return { ws, frames, closed };
  };

  it("closes a socket that never says anything, with the sentence the machine's own door speaks", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", authDeadlineMs: 60 });
    const { closed } = await opened(srv.port);
    expect(await closed).toEqual([4401, DAEMON_AUTH_DEADLINE_PASSED]);
  });

  it("closes a socket that sends more bytes than the door takes, and answers it nothing", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const { ws, frames, closed } = await opened(srv.port);
    // A well-formed auth frame with the right token, padded past the cap: the bytes are what refuse it.
    ws.send(JSON.stringify({ id: 1, op: "auth", token: "secret", pad: "x".repeat(5000) }));
    expect(await closed).toEqual([4401, DAEMON_PRE_AUTH_BYTES_EXCEEDED]);
    expect(frames).toEqual([]);
  });

  it("holds neither limit against a socket that is through the door", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", authDeadlineMs: 60 });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    await new Promise(resolve => setTimeout(resolve, 150));
    const big = await c.request("workspaces.list", { pad: "x".repeat(8 * 1024) });
    expect(big.ok).toBe(true);
    c.close();
  });
});

describe("the key a native client pins before it sends anything", () => {
  /** A runtime with the place wiring every host a person starts has, and the pair it proves itself with. */
  const served = (): { hostKey: PlaceKeyPair; runtime: Runtime } => {
    const hostKey = newPlaceKeyPair();
    return { hostKey, runtime: createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, placeLinks: { hostKey, provider: () => undefined, here: () => ({ name: "this-mac" }), hostName: () => "this-mac" } }) };
  };

  /** What a client does before its token crosses: its nonce and its half of a key agreement out, the host's key,
   * nonce, half and signature back, both checked, and the seal every frame after it rides inside. */
  const openSeal = async (c: WsClient, hostKey: PlaceKeyPair): Promise<Record<string, unknown>> => {
    const mine = freshEphemeral();
    const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
    const answer = await c.request("seal.open", { nonce, ephemeral: mine.publicKey });
    if (answer.ok !== true) return answer;
    const reply = SealOpenReply.parse(answer);
    expect(reply.hostPublicKey).toBe(hostKey.publicKey);
    expect(keyFingerprint(reply.hostPublicKey)).toBe(keyFingerprint(hostKey.publicKey));
    expect(verifyPlaceBytes(reply.hostPublicKey, placeLinkTranscript("host", SEAL_CLIENT, nonce, reply.nonce, { challenger: mine.publicKey, answerer: reply.ephemeral }), reply.signature)).toBe(true);
    c.seal = makeSeal(sealKeys(sharedSecret(mine.privateKey, reply.ephemeral), SEAL_CLIENT), "place");
    return answer;
  };

  it("answers the key, the nonce, the half and a signature over the client's transcript, and seals every frame after it", async () => {
    const { hostKey, runtime } = served();
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret", devices: runtime.devices });
    const c = await WsClient.connect(srv.port);
    await openSeal(c, hostKey);
    // The token crosses inside the seal, and the reply comes back inside it: a plaintext frame either way from
    // here on is somebody carrying the bytes writing into this socket.
    expect((await c.request("auth", { token: "secret" })).ok).toBe(true);
    expect((await c.request("workspaces.list")).ok).toBe(true);
    // The bytes on the wire are not the frame: a reader of the road sees no op and no token.
    const raw: Buffer[] = [];
    c.ws.on("message", data => raw.push(Buffer.from(data as Buffer)));
    await c.request("workspaces.list");
    expect(raw.every(bytes => !bytes.toString("utf8").includes("workspaces"))).toBe(true);
    c.close();
  });

  it("agrees one key per socket and closes a second ask, and refuses one on a socket already through the door", async () => {
    const { hostKey, runtime } = served();
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret", devices: runtime.devices });
    const first = await WsClient.connect(srv.port);
    await openSeal(first, hostKey);
    void first.request("seal.open", { nonce: randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64"), ephemeral: freshEphemeral().publicKey });
    expect(await first.closed()).toBe(4401);

    const authed = await WsClient.connect(srv.port, { token: "secret" });
    const late = await authed.request("seal.open", { nonce: randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64"), ephemeral: freshEphemeral().publicKey });
    expect(late.ok).toBe(false);
    authed.close();
  });

  it("refuses a place's own handshake on a socket that already agreed a key, so one key stands per socket", async () => {
    const { hostKey, runtime } = served();
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret", devices: runtime.devices });
    const c = await WsClient.connect(srv.port);
    await openSeal(c, hostKey);
    // A link's own agreement would replace the one this socket already counts its frames under, and a place has
    // no need of a socket a client opened: the frame is refused and the socket ends.
    const refused = await c.request("place.auth", { placeId: "p_1", nonce: randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64"), ephemeral: freshEphemeral().publicKey });
    expect(refused.ok).toBe(false);
    expect(await c.closed()).toBe(4401);

    const second = await WsClient.connect(srv.port);
    await openSeal(second, hostKey);
    const join = await second.request("place.join", { publicKey: newPlaceKeyPair().publicKey, nonce: randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64"), ephemeral: freshEphemeral().publicKey });
    expect(join.ok).toBe(false);
    expect(await second.closed()).toBe(4401);
  });

  it("says in one sentence that a runtime holding no key of its own cannot prove itself, and closes the socket", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port);
    const refused = await c.request("seal.open", { nonce: randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64"), ephemeral: freshEphemeral().publicKey });
    expect(refused.ok).toBe(false);
    expect(refused["error"]).toBe(SEAL_UNSERVED);
    expect(await c.closed()).toBe(4401);
  });
});

describe("serveRuntime and the page an upgrade came from", () => {
  /** What a dial gets when the host refuses the upgrade: the socket never opens and no frame is sent. */
  const refused = (url: string): Promise<string> =>
    new Promise((done, fail) => {
      const ws = new WebSocket(url);
      ws.once("error", (e: Error) => done(e.message));
      ws.once("open", () => {
        ws.close();
        fail(new Error(`${url} opened`));
      });
    });

  it("closes an upgrade the host's reading refuses, on its own port as well as on an attached server's", async () => {
    const app = createServer((_req, res) => res.end("hi"));
    await new Promise<void>(done => app.listen(0, "127.0.0.1", done));
    const appPort = (app.address() as { port: number }).port;
    let allowed = false;
    try {
      srv = await serveRuntime(rt(), { port: 0, authToken: "secret", attach: app, originAllowed: () => allowed });
      expect(await refused(`ws://127.0.0.1:${srv.port}`)).toMatch(/Unexpected server response/);
      expect(await refused(`ws://127.0.0.1:${appPort}${WS_PATH}`)).toContain("403");

      // And the same dials once the host's reading takes them: the door decides, this file only asks it.
      allowed = true;
      const own = await WsClient.connect(srv.port, { token: "secret" });
      const attached = await WsClient.connectTo(`ws://127.0.0.1:${appPort}${WS_PATH}`, { token: "secret" });
      own.close();
      attached.close();
    } finally {
      app.closeAllConnections();
      await new Promise<void>(done => app.close(() => done()));
    }
  });
});

describe("serveRuntime tickets (bearer never rides a URL after the handshake)", () => {
  it("issues a 5-minute single-use connect ticket that authenticates a second socket", async () => {
    let nowMs = 1_000_000;
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", now: () => nowMs });
    const c1 = await WsClient.connect(srv.port, { token: "secret" });
    const issued = await c1.request("ticket.issue", { purpose: "connect" });
    expect(issued.ok).toBe(true);
    const ticket = issued["ticket"] as string;
    expect(ticket).not.toContain("secret");
    expect(issued["expiresAt"]).toBe(nowMs + 300_000);

    const c2 = await WsClient.connect(srv.port, { ticket });
    const res = await c2.request("workspaces.list");
    expect(res.ok).toBe(true);

    // single-use: replaying the same ticket dies at 4401
    const c3 = await WsClient.connect(srv.port, { ticket });
    expect(await c3.closed()).toBe(4401);
    c1.close();
    c2.close();
  });

  it("expires tickets after 5 minutes", async () => {
    let nowMs = 1_000_000;
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", now: () => nowMs });
    const c1 = await WsClient.connect(srv.port, { token: "secret" });
    const issued = await c1.request("ticket.issue", { purpose: "connect" });
    nowMs += 300_001;
    const late = await WsClient.connect(srv.port, { ticket: issued["ticket"] as string });
    expect(await late.closed()).toBe(4401);
    c1.close();
  });
});

describe("serveRuntime events", () => {
  it("fans runtime events out to subscribed sockets only", async () => {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const sub = await WsClient.connect(srv.port, { token: "secret" });
    const quiet = await WsClient.connect(srv.port, { token: "secret" });
    await sub.request("events.subscribe");

    const created = await createOverWire(sub, "x", { golden: "snap_g" });
    expect(created.ok).toBe(true);
    await until(() => sub.events.some(e => e.type === "workspace.created"));
    expect(quiet.events).toEqual([]);
    sub.close();
    quiet.close();
  });
});

describe("serveRuntime capabilities", () => {
  it("capabilities.get returns the backend's flags so the UI degrades on facts, not probes", async () => {
    const backend = stubBackend();
    srv = await serveRuntime(createRuntime({ backend, store: memoryStore(), adapters: {} }), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const res = await c.request("capabilities.get");
    expect(res.ok).toBe(true);
    expect(res["capabilities"]).toEqual(backend.capabilities);
    c.close();
  });
});

describe("serveRuntime session history", () => {
  it("sessions.history returns the persisted session events for one workspace", async () => {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const id = (created["workspace"] as { id: string }).id;
    const res = await c.request("sessions.history", { workspaceId: id });
    expect(res.ok).toBe(true);
    expect(res["events"]).toEqual([]);
    const missing = await c.request("sessions.history", { workspaceId: "ws_nope" });
    expect(missing.ok).toBe(false);
    c.close();
  });
});

// A harness that cannot stop the process it owns is not a harness; the port refuses one at compile time.
const noStop = { localId: "s", finished: Promise.resolve<TurnResult>({ status: "completed" }) };
// @ts-expect-error interrupt is required on HarnessSession
noStop satisfies HarnessSession;

/** A harness the test ends by hand. Its interrupt does what the real one does: the turn reports
 * interrupted and the session ends on a later turn of the event loop than interrupt() resolves on. */
function stoppableHarness() {
  const sessionId = "55555555-5555-4555-8555-555555555555";
  let onEvent: ((e: AdapterEvent) => void) | undefined;
  let finish!: (r: TurnResult) => void;
  const finished = new Promise<TurnResult>(r => (finish = r));
  const end = (result: TurnResult): void => {
    onEvent!({ type: "turn.done", sessionId, result });
    onEvent!({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
    finish(result);
  };
  const h = {
    sessionId,
    interrupts: 0,
    steered: [] as string[],
    lastStart: undefined as HarnessStartOptions | undefined,
    complete: () => end({ status: "completed", text: "done" }),
    adapter: (() => ({
      steers: true,
      start: o => {
        onEvent = o.onEvent;
        h.lastStart = o;
        onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
        return {
          localId: sessionId,
          finished,
          interrupt: async () => {
            h.interrupts++;
            setImmediate(() => end({ status: "interrupted" }));
          },
          steer: async (prompt: string) => {
            h.steered.push(prompt);
            return "accepted" as const;
          },
        };
      },
    })) as HarnessAdapterFactory,
  };
  return h;
}

describe("serveRuntime harness catalog", () => {
  it("harnesses.list replies with one catalog per harness and sessions.start carries the picks through", async () => {
    const h = stoppableHarness();
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const listed = await c.request("harnesses.list");
    const catalogs = listed["harnesses"] as { harness: string; source: string; efforts: { value: string }[] }[];
    expect(catalogs.find(x => x.harness === "claude")?.efforts.map(o => o.value)).toContain("high");
    expect(catalogs.find(x => x.harness === "claude")?.source).toBe("table");
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    // On a workspace the machine is asked; the stub's binary says nothing, so the table answers, marked as such.
    const scoped = await c.request("harnesses.list", { workspaceId });
    expect((scoped["harnesses"] as { harness: string; source: string }[]).find(x => x.harness === "claude")?.source).toBe("table");
    const missing = await c.request("harnesses.list", { workspaceId: "ws_nope" });
    expect(missing.ok).toBe(false);
    const started = await c.request("sessions.start", { workspaceId, prompt: "go", model: "claude-opus-5-5", effort: "high", permissionMode: "plan", contextWindow: "1m", requestId: "req_9" });
    expect(started["session"]).toMatchObject({ model: "claude-sonnet-4-5", effort: "high", permissionMode: "plan", contextWindow: "1m" });
    expect(h.lastStart).toMatchObject({ model: "claude-opus-5-5", effort: "high", permissionMode: "plan", contextWindow: "1m" });
    expect(h.lastStart).not.toHaveProperty("requestId");
    h.complete();
    const history = (await c.request("sessions.history", { workspaceId }))["events"] as { type: string; requestId?: string }[];
    expect(history[0]).toMatchObject({ type: "session.start", requestId: "req_9" });
    c.close();
  });
});

describe("serveRuntime session interrupt", () => {
  type Harness = ReturnType<typeof stoppableHarness>;
  const table: { name: string; before?: (h: Harness) => void; sessionId?: string; outcome: string; interrupts: number; status?: string }[] = [
    { name: "mid-turn: the harness is told to stop and the turn ends interrupted", outcome: "accepted", interrupts: 1, status: "interrupted" },
    { name: "after the turn: not-running, and the harness is not asked", before: h => h.complete(), outcome: "not-running", interrupts: 0, status: "completed" },
    { name: "unknown session: not-found", sessionId: "ws_nobody", outcome: "not-found", interrupts: 0 },
  ];

  it.each(table)("$name", async row => {
    const h = stoppableHarness();
    const fc = fakeClock();
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter }, clock: fc.clock });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    await c.request("events.subscribe");
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    const started = await c.request("sessions.start", { workspaceId, prompt: "go" });
    expect(started["session"]).toMatchObject({ id: h.sessionId, status: "running" });
    row.before?.(h);
    // Frames in arrival order, so the check below reads the wire and not a coalesced read of c.events.
    const arrived: string[] = [];
    c.ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as { id?: number; type?: string };
      arrived.push(m.type ?? `reply:${String(m.id)}`);
    });

    const res = await c.request("sessions.interrupt", { sessionId: row.sessionId ?? h.sessionId });
    expect(res).toEqual({ id: expect.any(Number), ok: true, outcome: row.outcome });
    expect(h.interrupts).toBe(row.interrupts);

    if (row.status !== undefined) {
      const listed = await c.request("sessions.list", { workspaceId });
      expect(listed["sessions"]).toMatchObject([{ id: h.sessionId, status: row.status }]);
      const history = (await c.request("sessions.history", { workspaceId }))["events"] as { type: string; result?: { status: string } }[];
      expect(history.map(e => e.type)).toEqual(["session.start", "session.done", "session.end"]);
      expect(history[1]).toMatchObject({ type: "session.done", result: { status: row.status } });
      expect(c.events.filter(e => e.type === "session.done")).toMatchObject([{ result: { status: row.status } }]);
      const reply = `reply:${String(res.id)}`;
      if (row.outcome === "accepted") expect(arrived.slice(0, arrived.indexOf(reply) + 1)).toEqual(["session.done", "session.end", reply]);
    }
    c.close();
  });

  it("sessions.steer round-trips: the session.steer event reaches subscribers before the accepted reply, and history holds it", async () => {
    const h = stoppableHarness();
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    await c.request("events.subscribe");
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    await c.request("sessions.start", { workspaceId, prompt: "go", requestId: "req_1" });
    const arrived: string[] = [];
    c.ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as { id?: number; type?: string };
      arrived.push(m.type ?? `reply:${String(m.id)}`);
    });
    const res = await c.request("sessions.steer", { sessionId: h.sessionId, prompt: "and the tests", requestId: "req_2" });
    expect(res).toEqual({ id: expect.any(Number), ok: true, outcome: "accepted" });
    expect(h.steered).toEqual(["and the tests"]);
    expect(arrived).toEqual(["session.steer", `reply:${String(res.id)}`]);
    expect(c.events.filter(e => e.type === "session.steer")).toMatchObject([{ workspaceId, sessionId: h.sessionId, prompt: "and the tests", requestId: "req_2" }]);
    h.complete();
    const history = (await c.request("sessions.history", { workspaceId }))["events"] as { type: string; turnId?: string }[];
    expect(history.map(e => e.type)).toEqual(["session.start", "session.steer", "session.done", "session.end"]);
    expect(history[1]!.turnId).toBe(history[0]!.turnId);
    expect((await c.request("sessions.steer", { sessionId: h.sessionId, prompt: "late" }))["outcome"]).toBe("not-running");
    expect((await c.request("sessions.steer", { sessionId: "nope", prompt: "x" }))["outcome"]).toBe("not-found");
    expect((await c.request("sessions.steer", { sessionId: h.sessionId })).ok).toBe(false);
    c.close();
  });

  it("sessions.start replies with how the start went: started on a fresh thread, steered when the thread's turn runs and the harness steers, with the running turn as the session", async () => {
    const h = stoppableHarness();
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    await c.request("events.subscribe");
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    const first = await c.request("sessions.start", { workspaceId, prompt: "go", requestId: "req_1" });
    expect(first).toMatchObject({ ok: true, outcome: "started", turnId: expect.any(String), session: { id: h.sessionId, status: "running" } });
    expect(c.events.filter(e => e.type === "session.start")).toMatchObject([{ turnId: first["turnId"] }]);
    const joined = await c.request("sessions.start", { workspaceId, prompt: "and STEERED", resume: h.sessionId, requestId: "req_2", startedBy: "cli" });
    expect(joined).toMatchObject({ ok: true, outcome: "steered", turnId: first["turnId"], session: { id: h.sessionId, status: "running", prompt: "go" } });
    expect((joined["session"] as { threadId: string }).threadId).toBe((first["session"] as { threadId: string }).threadId);
    expect(h.steered).toEqual(["and STEERED"]);
    expect(c.events.filter(e => e.type === "session.start")).toHaveLength(1);
    expect(c.events.filter(e => e.type === "session.steer")).toMatchObject([{ prompt: "and STEERED", requestId: "req_2" }]);
    // The thread field reaches the runtime: naming the thread lands on its running turn like naming its session did.
    const byThread = await c.request("sessions.start", { workspaceId, prompt: "and BY THREAD", thread: (first["session"] as { threadId: string }).threadId, requestId: "req_3" });
    expect(byThread).toMatchObject({ ok: true, outcome: "steered", turnId: first["turnId"] });
    expect(h.steered).toEqual(["and STEERED", "and BY THREAD"]);
    const unknown = await c.request("sessions.start", { workspaceId, prompt: "nowhere", thread: "thr_nope" });
    expect(unknown).toMatchObject({ ok: false, error: "no thread thr_nope on this workspace" });
    h.complete();
    c.close();
  });

  it("interrupting the same turn twice is accepted once, then not-running", async () => {
    const h = stoppableHarness();
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter }, clock: fakeClock().clock });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    await c.request("sessions.start", { workspaceId: (created["workspace"] as { id: string }).id, prompt: "go" });
    expect((await c.request("sessions.interrupt", { sessionId: h.sessionId }))["outcome"]).toBe("accepted");
    expect((await c.request("sessions.interrupt", { sessionId: h.sessionId }))["outcome"]).toBe("not-running");
    expect(h.interrupts).toBe(1);
    c.close();
  });
});

describe("serveRuntime port reach", () => {
  it("workspaces.portReach returns the route a browser frames, without the daemon token; an unknown workspace is refused", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    srv = await serveRuntime(createRuntime({ backend, store: memoryStore(), adapters: {} }), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const id = (created["workspace"] as { id: string }).id;
    backend.machines[0]!.previewUrl = async port => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: 1_800_000_000_000 });
    const res = await c.request("workspaces.portReach", { workspaceId: id, port: 3000 });
    expect(res.ok).toBe(true);
    expect(res["reach"]).toEqual({ url: "https://m1-3000.preview.example/?pt_token=e", expiresAt: 1_800_000_000_000 });
    const missing = await c.request("workspaces.portReach", { workspaceId: "ws_nobody", port: 3000 });
    expect(missing.ok).toBe(false);
    expect(missing["error"]).toMatch(/no such workspace/);
    c.close();
  });

  it("workspaces.portProbe replies with what the host saw on the port's route; an unknown workspace is refused", async () => {
    const guest = createServer((_req, res) => res.writeHead(403, { "content-type": "text/plain" }).end("Blocked request. This host (m1-5173.preview.example) is not allowed. To allow this host, add it to server.allowedHosts"));
    await new Promise<void>(r => guest.listen(0, "127.0.0.1", r));
    const addr = guest.address();
    const guestPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      const backend = stubBackend();
      backend.execImpl = tokenGuest;
      srv = await serveRuntime(createRuntime({ backend, store: memoryStore(), adapters: {} }), { port: 0, authToken: "secret" });
      const c = await WsClient.connect(srv.port, { token: "secret" });
      const created = await createOverWire(c, "x", { golden: "snap_g" });
      const id = (created["workspace"] as { id: string }).id;
      backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${guestPort}/?pt_token=e`, token: "e", expiresAt: 1_800_000_000_000 });
      const res = await c.request("workspaces.portProbe", { workspaceId: id, port: 5173 });
      expect(res.ok).toBe(true);
      expect(res["probe"]).toEqual({ status: 403, body: expect.stringContaining("server.allowedHosts") });
      const missing = await c.request("workspaces.portProbe", { workspaceId: "ws_nobody", port: 5173 });
      expect(missing.ok).toBe(false);
      expect(missing["error"]).toMatch(/no such workspace/);
      c.close();
    } finally {
      await new Promise<void>(r => guest.close(() => r()));
    }
  });

  it("workspaces.rebuild replies with the workspace on a fresh golden fork and the old machine is dead", async () => {
    const backend = stubBackend();
    srv = await serveRuntime(createRuntime({ backend, store: memoryStore(), adapters: {} }), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const id = (created["workspace"] as { id: string }).id;
    const res = await c.request("workspaces.rebuild", { workspaceId: id });
    expect(res.ok).toBe(true);
    expect(res["workspace"]).toMatchObject({ id, name: "x", machineId: "m2", phase: "running" });
    expect(backend.machines[0]!.killed).toBe(true);
    expect(backend.machines[1]!.spec.fromSnapshot).toBe("snap_g");
    const missing = await c.request("workspaces.rebuild", { workspaceId: "ws_nobody" });
    expect(missing.ok).toBe(false);
    c.close();
  });
});

describe("serveRuntime golden wizard ops", () => {
  const recipe = { setup: "curl install", smoke: "claude --version", envs: { ANTHROPIC_API_KEY: "k" } };

  it("golden.prepare replies with the builder and its screen, golden.seal writes v1 of desktop kind, and no machine survives", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    // Pinned: the seal names its snapshot for this host, so an unpinned identity would name it after this machine.
    const runtime = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe, hostId: "box:h1" });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    await c.request("events.subscribe");

    const prepared = await c.request("golden.prepare", { name: "default", kind: "desktop" });
    expect(prepared.ok).toBe(true);
    expect(prepared["builder"]).toMatchObject({ id: "m1", name: "default", kind: "desktop", screen: { streamUrl: "wss://stub/stream/m1" } });
    expect(backend.machines[0]!.spec).toMatchObject({ kind: "desktop", template: "default", envs: { ANTHROPIC_API_KEY: "k" } });
    expect(backend.machines[0]!.spec.labels).toMatchObject({ wsp: "1", "wsp-builder": "1" });
    // The base stage's steps run first, the harness install is the last thing on the builder, under the harness guard.
    expect(backend.machines[0]!.execLog.filter(c => c.includes("apt-get install -y -qq git"))).toHaveLength(1);
    expect(backend.machines[0]!.execLog.at(-1)).toMatch(/\nsetsid bash -c 'set -euo pipefail\n[^]*\ncurl install' &\n/);
    // the builder is not a workspace
    expect((await c.request("workspaces.list"))["workspaces"]).toEqual([]);
    expect(await store.list("builders")).toHaveLength(1);

    const sealed = await c.request("golden.seal", { builderId: "m1" });
    expect(sealed.ok).toBe(true);
    expect(sealed["version"]).toMatchObject({ version: 1, kind: "desktop", snapshotId: "snap_wsp-h1-default-v1", smoke: { cmd: "claude --version", exitCode: 0 } });
    expect((sealed["manifest"] as { head: number }).head).toBe(1);
    expect(backend.machines.map(m => [m.id, m.kind, m.killed])).toEqual([["m1", "desktop", true], ["m2", "desktop", true]]);
    expect(backend.machines[1]!.spec.fromSnapshot).toBe("snap_wsp-h1-default-v1");
    expect(backend.machines[1]!.execLog).toEqual(["claude --version", "test -x /usr/local/bin/wsp-open"]);
    expect(await store.list("builders")).toEqual([]);
    expect((await c.request("golden.get", { name: "default" }))["manifest"]).toEqual(sealed["manifest"]);

    await until(() => c.events.some(e => e.type === "golden.stage" && e["stage"] === "sealed"));
    const stages = c.events.filter(e => e.type === "golden.stage").map(e => e["stage"]);
    expect([...new Set(stages)]).toEqual(["creating", "deploying-daemon", "installing-harness", "ready", "snapshotting", "smoke-forking", "sealed"]);
    expect(c.events.filter(e => e.type === "golden.stage").every(e => e["name"] === "default")).toBe(true);
    c.close();
  });

  it("golden.prepare defaults to a sandbox with no screen, and the builder's daemon route stays inside this host", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, daemonToken: DAEMON_TOKEN });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });

    const prepared = await c.request("golden.prepare", { name: "default" });
    expect(prepared["builder"]).toMatchObject({ id: "m1", kind: "sandbox" });
    expect(prepared["builder"]).not.toHaveProperty("screen");
    expect(backend.machines[0]!.spec).toMatchObject({ kind: "sandbox", template: "base" });

    backend.machines[0]!.previewUrl = async port => ({ url: `https://m1-${port}.preview.example/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 });
    // The route and the token a builder's daemon is opened with are the host's own; no op hands either one out.
    expect(await runtime.golden.builderReach("m1")).toEqual({ url: "https://m1-7070.preview.example/?pt_token=edge", expiresAt: expect.any(Number), daemonToken: daemonTokenFor(DAEMON_TOKEN, "m1") });
    expect(await c.request("golden.builderReach", { builderId: "m1" })).toMatchObject({ ok: false, error: expect.stringMatching(/Invalid discriminator value/) });
    c.close();
  });

  it("golden.seal on a builder hydrated by a later process and found paused is refused as notFirstLife and the builder dies", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const builder = await first.golden.prepare();
    backend.machines[0]!.paused = true;
    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    srv = await serveRuntime(second, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    expect((await c.request("golden.prepare", { name: "default" })).ok).toBe(true); // a fresh one is fine
    const refused = await c.request("golden.seal", { builderId: builder.id });
    expect(refused).toMatchObject({ ok: false, kind: "notFirstLife" });
    expect(refused["error"]).toMatch(/first-life/);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(backend.machines.filter(m => !m.killed)).toHaveLength(1);
    expect(await second.golden.get()).toBeUndefined();
    c.close();
  });

  it("golden.prepare fails plainly when the runtime has no recipe", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const res = await c.request("golden.prepare", { name: "default" });
    expect(res.ok).toBe(false);
    expect(res["error"]).toMatch(/no golden recipe/);
    c.close();
  });
});

describe("serveRuntime snapshot lineage", () => {
  const version = (n: number) => ({
    version: n,
    snapshotId: `snap_golden-v${n}`,
    baseTemplate: "base",
    setupSha: `sha${n}`,
    createdAt: `2026-08-${10 + n}T00:00:00.000Z`,
    smoke: { cmd: "true", exitCode: 0 },
  });

  it("snapshots.list is the manifest with head; rollback moves head, says existing workspaces are untouched, persists", async () => {
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 2, versions: [version(1), version(2)] });
    srv = await serveRuntime(createRuntime({ backend: stubBackend(), store, adapters: {} }), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });

    const listed = await c.request("snapshots.list");
    expect(listed.ok).toBe(true);
    expect(listed["lineage"]).toEqual({ name: "default", head: 2, versions: [version(1), version(2)] });

    const rolled = await c.request("snapshots.rollback", { version: 1 });
    expect(rolled.ok).toBe(true);
    expect(rolled["lineage"]).toEqual({ name: "default", head: 1, versions: [version(1), version(2)] });
    expect(rolled["existingWorkspaces"]).toBe("untouched");
    expect((await c.request("golden.get", { name: "default" }))["manifest"]).toEqual({ head: 1, versions: [version(1), version(2)] });

    const empty = await c.request("snapshots.list", { name: "other" });
    expect(empty["lineage"]).toEqual({ name: "other", head: null, versions: [] });
    c.close();
  });

  it("snapshots.rollback to a version outside the manifest is a typed refusal that changes nothing", async () => {
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [version(1)] });
    srv = await serveRuntime(createRuntime({ backend: stubBackend(), store, adapters: {} }), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const refused = await c.request("snapshots.rollback", { version: 9 });
    expect(refused).toMatchObject({ ok: false, kind: "missing" });
    expect(String(refused["error"])).toContain("v9");
    expect((await c.request("snapshots.list"))["lineage"]).toMatchObject({ head: 1 });
    c.close();
  });
});

describe("serveRuntime forwards (the host's, listed and stopped from the app)", () => {
  function fakeForwards() {
    const listeners = new Set<(e: ForwardEvent) => void>();
    const open: PortForward[] = [];
    const stops: [string, number][] = [];
    const source: ForwardsSource = {
      list: () => [...open],
      stop: (workspaceId, port) => {
        stops.push([workspaceId, port]);
        const i = open.findIndex(f => f.workspaceId === workspaceId && f.port === port);
        if (i < 0) return false;
        open.splice(i, 1);
        return true;
      },
      on: fn => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const emit = (e: ForwardEvent): void => {
      for (const fn of listeners) fn(e);
    };
    return { source, open, stops, emit, listeners };
  }

  it("forwards.list is the source's list, forwards.stop closes one and refuses an unknown one", async () => {
    const { source, open, stops } = fakeForwards();
    open.push({ workspaceId: "ws_1", port: 8123, startedAt: "2026-09-04T10:00:00.000Z", name: "api", kind: "url" });
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", forwards: source });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    expect((await c.request("forwards.list"))["forwards"]).toEqual([{ workspaceId: "ws_1", port: 8123, startedAt: "2026-09-04T10:00:00.000Z", name: "api", kind: "url" }]);
    expect((await c.request("forwards.stop", { workspaceId: "ws_1", port: 8123 })).ok).toBe(true);
    const again = await c.request("forwards.stop", { workspaceId: "ws_1", port: 8123 });
    expect(again.ok).toBe(false);
    expect(again["error"]).toBe("nothing is forwarding localhost:8123 for that workspace");
    expect(stops).toEqual([["ws_1", 8123], ["ws_1", 8123]]);
    expect((await c.request("forwards.list"))["forwards"]).toEqual([]);
    // Below 1024 never reaches the source: the wire refuses it.
    expect((await c.request("forwards.stop", { workspaceId: "ws_1", port: 80 })).ok).toBe(false);
    expect(stops).toHaveLength(2);
    c.close();
  });

  it("forward events reach subscribed sockets only, and the subscription dies with the socket", async () => {
    const { source, emit, listeners } = fakeForwards();
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", forwards: source });
    const sub = await WsClient.connect(srv.port, { token: "secret" });
    const quiet = await WsClient.connect(srv.port, { token: "secret" });
    await sub.request("events.subscribe");
    const f = { workspaceId: "ws_1", port: 8123, startedAt: "2026-09-04T10:00:00.000Z", name: "api", kind: "url" as const };
    emit({ type: "forward.open", forward: f });
    emit({ type: "forward.close", workspaceId: "ws_1", port: 8123 });
    await until(() => sub.events.length === 2);
    expect(sub.events).toEqual([{ type: "forward.open", forward: f }, { type: "forward.close", workspaceId: "ws_1", port: 8123 }]);
    expect(quiet.events).toEqual([]);
    sub.close();
    await until(() => listeners.size === 0);
    quiet.close();
  });

  it("without a source the list is empty and a stop is refused", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    expect((await c.request("forwards.list"))["forwards"]).toEqual([]);
    expect((await c.request("forwards.stop", { workspaceId: "ws_1", port: 8123 })).ok).toBe(false);
    c.close();
  });
});

describe("serveRuntime thread provenance", () => {
  it("sessions.start records who asked, cli when the request says so and person when it says nothing, and sessions.list carries it", async () => {
    const h = stoppableHarness();
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    const rows = async (): Promise<string[]> => ((await c.request("sessions.list", { workspaceId }))["sessions"] as { startedBy: string }[]).map(s => s.startedBy);
    const byCli = await c.request("sessions.start", { workspaceId, prompt: "go", startedBy: "cli" });
    expect(byCli["session"]).toMatchObject({ startedBy: "cli" });
    expect(await rows()).toEqual(["cli"]);
    h.complete();
    // The stoppable harness reuses one local id, so the second start replaces the first row.
    const byPerson = await c.request("sessions.start", { workspaceId, prompt: "go on" });
    expect(byPerson["session"]).toMatchObject({ startedBy: "person" });
    expect(await rows()).toEqual(["person"]);
    const refused = await c.request("sessions.start", { workspaceId, prompt: "go", startedBy: "app" });
    expect(refused.ok).toBe(false);
    c.close();
  });
});

/** A guest for the exec stream's launch and poll contract: the launch lands, the first poll hands over the whole
 * log, and the leader is up until the exit file is written or the stream signals it. */
function execGuest(backend: StubBackend, output: string, exit: number | undefined) {
  const base = backend.execImpl;
  let alive = true;
  backend.execImpl = (m, cmd) => {
    if (cmd.includes("base64 -d")) return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
    if (cmd.includes("kill -TERM") || cmd.includes("kill -KILL")) {
      alive = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const sentinel = /(__WSP_EOF_[a-z0-9]+__)/.exec(cmd)?.[1];
    if (sentinel !== undefined) {
      const from = Number(/tail -c \+(\d+)/.exec(cmd)?.[1] ?? "1") - 1;
      const chunk = Buffer.from(output).subarray(from).toString("base64");
      return { exitCode: 0, stdout: `${chunk}\n${sentinel} ${exit ?? ""} ${alive ? "up" : "down"}\n`, stderr: "" };
    }
    return base(m, cmd);
  };
}

/** A harness that never runs here; it says what a turn on the machine is exported with, which is what exec runs with too. */
const envAdapter = (env: Record<string, string>): HarnessAdapterFactory => () => ({
  steers: false,
  start: () => {
    throw new Error("not started in this test");
  },
  env,
});

describe("serveRuntime workspaces.exec", () => {
  it("replies with an exec id, pushes each output line to the asking socket and the exit code last, and pushes nothing to another socket", async () => {
    const backend = stubBackend();
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: { claude: envAdapter({ CLAUDE_CONFIG_DIR: "/root/.claude", PATH: "/usr/bin" }) } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const other = await WsClient.connect(srv.port, { token: "secret" });
    await other.request("events.subscribe");
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    execGuest(backend, "one\ntwo\n", 3);

    const started = await c.request("workspaces.exec", { workspaceId, argv: ["sh", "-c", "printf 'one\\ntwo\\n'; exit 3"] });
    expect(started.ok).toBe(true);
    const execId = started["execId"] as string;
    expect(execId).toMatch(/^[0-9a-f]{12}$/);
    await until(() => c.events.some(e => e.type === "exec.exit"));
    expect(c.events).toEqual([
      { type: "exec.output", execId, text: "one" },
      { type: "exec.output", execId, text: "two" },
      { type: "exec.exit", execId, exitCode: 3 },
    ]);
    expect(other.events.filter(e => String(e.type).startsWith("exec."))).toEqual([]);
    // The command travels base64-encoded inside the launch script, each word quoted for the machine's shell, after
    // the same exports a harness turn gets.
    const launch = backend.machines[0]!.execLog.find(cmd => cmd.includes("base64 -d"))!;
    const script = Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(launch)![1]!, "base64").toString("utf8");
    expect(script).toContain("export CLAUDE_CONFIG_DIR='/root/.claude'\nexport PATH='/usr/bin'\n");
    expect(script).toContain("'sh' '-c' 'printf '\\''one\\ntwo\\n'\\''; exit 3'\n");

    const missing = await c.request("workspaces.exec", { workspaceId: "ws_nope", argv: ["true"] });
    expect(missing.ok).toBe(false);
    c.close();
    other.close();
    // A command that has exited is reaped with its files once, and not signalled again when its socket goes.
    await new Promise(r => setTimeout(r, 50));
    const kills = backend.machines[0]!.execLog.filter(cmd => cmd.includes("kill -TERM") || cmd.includes("kill -KILL"));
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatch(/kill -TERM -- -\$P .*kill -KILL -- -\$P .*rm -rf '\/tmp\/wsp-run\/[a-f0-9]{12}'\.\*/);
  });

  it("runs the command in the folder the request names, quoted for the machine's shell; without one, in the home, as a harness turn does", async () => {
    const backend = stubBackend();
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: { claude: envAdapter({ PATH: "/usr/bin" }) } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    execGuest(backend, "", 0);
    const scripts = (): string[] => backend.machines[0]!.execLog.filter(cmd => cmd.includes("base64 -d")).map(launch => Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(launch)![1]!, "base64").toString("utf8"));

    const inFolder = await c.request("workspaces.exec", { workspaceId, argv: ["git", "status"], cwd: "/root/work/my proj" });
    expect(inFolder.ok).toBe(true);
    // The reply says where it ran, so a client prints that rather than restating the rule the runtime holds.
    expect(inFolder["cwd"]).toBe("/root/work/my proj");
    await until(() => c.events.some(e => e.type === "exec.exit" && e["execId"] === inFolder["execId"]));
    expect(scripts().at(-1)).toContain("export PATH='/usr/bin'\ncd '/root/work/my proj' && 'git' 'status'\necho $? > ");

    const bare = await c.request("workspaces.exec", { workspaceId, argv: ["git", "status"] });
    expect(bare.ok).toBe(true);
    // With no folder named the command runs where the workspace's project sits, the same folder a turn opens in.
    const held = (created["workspace"] as { project: { path: string } }).project.path;
    expect(bare["cwd"]).toBe(held);
    await until(() => c.events.some(e => e.type === "exec.exit" && e["execId"] === bare["execId"]));
    expect(scripts().at(-1)).toContain(`export PATH='/usr/bin'\ncd '${held}' && 'git' 'status'\necho $? > `);
    c.close();
  });

  it("refuses like sessions.start when no adapter is registered for the harness whose environment it would run with", async () => {
    const backend = stubBackend();
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: {} });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    const refused = await c.request("workspaces.exec", { workspaceId, argv: ["true"] });
    expect(refused).toMatchObject({ ok: false, error: 'no adapter registered for harness "claude"; agents on this host: none' });
    expect(backend.machines[0]!.execLog.some(cmd => cmd.includes("base64 -d"))).toBe(false);
  });

  it("the asking socket closing ends the command", async () => {
    const backend = stubBackend();
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: { claude: envAdapter({}) } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    execGuest(backend, "", undefined);
    const started = await c.request("workspaces.exec", { workspaceId, argv: ["sleep", "600"] });
    expect(started.ok).toBe(true);
    const log = backend.machines[0]!.execLog;
    await until(() => log.some(cmd => cmd.includes("__WSP_EOF_")));
    c.close();
    await until(() => log.some(cmd => cmd.includes("kill -TERM")));
  });

  it("deleting the workspace ends a running exec with the deleted reason on the asking socket", async () => {
    const backend = stubBackend();
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: { claude: envAdapter({}) } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    execGuest(backend, "", undefined);
    const started = await c.request("workspaces.exec", { workspaceId, argv: ["sleep", "600"] });
    const execId = started["execId"] as string;
    const log = backend.machines[0]!.execLog;
    await until(() => log.some(cmd => cmd.includes("__WSP_EOF_")));
    const deleted = await c.request("workspaces.delete", { workspaceId });
    expect(deleted.ok).toBe(true);
    await until(() => c.events.some(e => e.type === "exec.exit"));
    expect(c.events.filter(e => e.type === "exec.exit")).toEqual([
      { type: "exec.exit", execId, exitCode: null, error: "machine deleted while the agent was working" },
    ]);
    c.close();
  });

  it("napping the workspace ends a running exec with the paused reason on the asking socket", async () => {
    const backend = stubBackend();
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: { claude: envAdapter({}) } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    execGuest(backend, "", undefined);
    const started = await c.request("workspaces.exec", { workspaceId, argv: ["sleep", "600"] });
    const execId = started["execId"] as string;
    const log = backend.machines[0]!.execLog;
    await until(() => log.some(cmd => cmd.includes("__WSP_EOF_")));
    const napped = await c.request("workspaces.nap", { workspaceId });
    expect(napped.ok).toBe(true);
    await until(() => c.events.some(e => e.type === "exec.exit"));
    expect(c.events.filter(e => e.type === "exec.exit")).toEqual([
      { type: "exec.exit", execId, exitCode: null, error: "machine paused while the agent was working" },
    ]);
    c.close();
  });

  it("carries the stop of a wake the provider never took, so the row's own stop reaches the runtime", async () => {
    const backend = stubBackend();
    backend.lifecycle.budgets.resumeAsks!.everyMs = 10;
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: {} });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await createOverWire(c, "x", { golden: "snap_g" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    await c.request("workspaces.nap", { workspaceId });
    const m = backend.machines[0]!;
    let asked = 0;
    m.resume = async (signal?: AbortSignal) => {
      asked++;
      return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(abortedCall(`resume of ${m.id}`)), { once: true }));
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const waking = c.request("workspaces.wake", { workspaceId });
      await until(() => asked === 1);
      const stopped = await c.request("workspaces.stopWake", { workspaceId });
      expect((stopped["workspace"] as { phase: string }).phase).toBe("napping");
      expect((await waking).ok).toBe(false);
    } finally {
      warn.mockRestore();
    }
    c.close();
  });
});

describe("serveRuntime init door (the host's init job, read and driven from the app)", () => {
  const JOB: InitJob = { id: "init_1", road: "manual", phase: "answering", keys: { box: false, solari: true }, step: 0, stoppable: true, screens: [], rows: [], progress: { done: 0, total: 0 }, log: [] };
  const SETUP = { keys: { box: false, solari: true }, keyProvider: "solari", home: "/Users/me", agents: [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null };
  function fakeDoor() {
    const calls: unknown[] = [];
    const listeners = new Set<Parameters<InitDoor["on"]>[0]>();
    const door: InitDoor = {
      get: async () => SETUP,
      // As the host answers: one entry per provider it can hold a key for, the one just saved true.
      keys: async k => {
        calls.push(["keys", k]);
        return { ...SETUP, keys: { ...SETUP.keys, ...(k.provider === undefined ? {} : { [k.provider]: true }) } };
      },
      step: async o => {
        calls.push(["step", o]);
        return { ...JOB, step: o.at };
      },
      draft: async o => {
        calls.push(["draft", o]);
        return { ...JOB, drafts: [{ at: o.at, ticks: o.ticks ?? [], answers: o.answers ?? {} }] };
      },
      retry: async o => {
        calls.push(["retry", o]);
        return JOB;
      },
      start: async o => {
        calls.push(["start", o]);
        return { ...JOB, road: o.road, phase: "reading" as const };
      },
      answer: async o => {
        calls.push(["answer", o]);
        return JOB;
      },
      build: async o => {
        calls.push(["build", o]);
        return { ...JOB, phase: "building" as const };
      },
      signInCode: async o => {
        calls.push(["signInCode", o]);
        return { ...JOB, phase: "signing-in" as const };
      },
      cancel: async () => {
        calls.push(["cancel"]);
        return { ...JOB, phase: "cancelled" as const };
      },
      on: fn => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    return {
      door,
      calls,
      emit: (job: typeof JOB) => listeners.forEach(fn => fn({ type: "init.job", job })),
      need: (needsYou: { what: string; since: number }) => listeners.forEach(fn => fn({ type: "job.needs-you", jobId: JOB.id, needsYou })),
      listeners,
    };
  }

  it("every init op reaches the door with its fields and answers with its view; a key never comes back", async () => {
    const { door, calls } = fakeDoor();
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", init: door });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    expect((await c.request("init.get"))["setup"]).toEqual(SETUP);
    const saved = await c.request("init.keys", { provider: "box", key: "ascii_live_fake", rows: { "logins/claude": "sk-ant-x" } });
    expect(saved["setup"]).toEqual({ ...SETUP, keys: { box: true, solari: true } });
    expect(JSON.stringify(saved)).not.toMatch(/ascii_live_fake|sk-ant-x/);
    expect((await c.request("init.start", { road: "agent", harness: "claude" }))["job"]).toMatchObject({ road: "agent", phase: "reading" });
    expect((await c.request("init.answer", { screen: "tools", ticks: ["gh"], answers: { "logins/gh": "machine" } }))["job"]).toEqual(JOB);
    expect((await c.request("init.step", { at: 2 }))["job"]).toMatchObject({ step: 2 });
    expect((await c.request("init.retry", { tool: "gh" }))["job"]).toEqual(JOB);
    expect((await c.request("init.build", { firstWorkspace: "first", rebuild: true }))["job"]).toMatchObject({ phase: "building" });
    expect((await c.request("init.signInCode", { tool: "gcloud", code: "4/0Afake" }))["job"]).toMatchObject({ phase: "signing-in" });
    expect((await c.request("init.cancel"))["job"]).toMatchObject({ phase: "cancelled" });
    // The door is the one home for what the build op takes: naming the whole object here is what makes a field the
    // server spreads in and the door never declared a type error rather than a field nothing checks.
    const built: Parameters<InitDoor["build"]>[0] = { firstWorkspace: "first", rebuild: true };
    expect(calls).toEqual([
      ["keys", { provider: "box", key: "ascii_live_fake", rows: { "logins/claude": "sk-ant-x" } }],
      ["start", { road: "agent", harness: "claude" }],
      ["answer", { screen: "tools", ticks: ["gh"], answers: { "logins/gh": "machine" } }],
      ["step", { at: 2 }],
      ["retry", { tool: "gh" }],
      ["build", built],
      ["signInCode", { tool: "gcloud", code: "4/0Afake" }],
      ["cancel"],
    ]);
    c.close();
  });

  it("without a door every init op is refused in one line, and the events channel still serves", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const refused = await c.request("init.get");
    expect(refused.ok).toBe(false);
    expect(refused["error"]).toBe("this runtime has no init job; the host that serves the app wires one");
    expect((await c.request("events.subscribe")).ok).toBe(true);
    c.close();
  });

  it("init.job and job.needs-you events reach subscribed sockets and the subscription dies with the socket", async () => {
    const { door, emit, need, listeners } = fakeDoor();
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", init: door });
    const sub = await WsClient.connect(srv.port, { token: "secret" });
    const quiet = await WsClient.connect(srv.port, { token: "secret" });
    await sub.request("events.subscribe");
    emit({ ...JOB, phase: "building" });
    // The wait on the person rides the same channel, so a client that speaks once per need has its one signal.
    need({ what: "sign in to GitHub CLI login", since: 1_760_000_000_000 });
    await until(() => sub.events.length === 2);
    expect(sub.events).toEqual([
      { type: "init.job", job: { ...JOB, phase: "building" } },
      { type: "job.needs-you", jobId: JOB.id, needsYou: { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 } },
    ]);
    expect(quiet.events).toEqual([]);
    sub.close();
    await until(() => listeners.size === 0);
    quiet.close();
  });
});

describe("serveRuntime the doctor's computer road", () => {
  const HERE = { name: "zingzys-mac", os: "macOS 15.0", shape: { cpu: 8, memMb: 16384 }, engine: "docker" as const };
  const record: PlaceRecord = {
    id: "p_1",
    name: "spoo",
    publicKey: "k",
    joinedAt: "2026-09-18T09:00:00.000Z",
    lastSeenAt: "2026-09-18T09:00:00.000Z",
    report: {
      name: "spoo",
      platform: "linux",
      arch: "x64",
      os: "Ubuntu 24.04",
      shape: { cpu: 4, memMb: 4096 },
      login: { HOME: "/root", USER: "root", PATH: "/usr/bin" },
      runsWorkspaces: true,
      engine: "none",
      daemonVersion: 54,
      agents: [],
      wsp: ["/usr/local/bin/wsp"],
      dialed: "http://192.168.1.20:14621",
    },
  };

  /** A host that holds one computer, one cloud row and its own, with the doctor's road wired or not. */
  async function serving(doctor?: PlaceDoctor): Promise<RuntimeServer> {
    const store = memoryStore();
    await store.put("places", record.id, record);
    const runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: { hostKey: newPlaceKeyPair(), provider: () => ({ id: "solari", rateUsdPerHour: 1 }), here: () => HERE, hostName: () => "zingzys-mac" },
    });
    doctorRt = runtime;
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret", ...(doctor === undefined ? {} : { doctor }) });
    return srv;
  }

  /** A road that says the lines it was given through its own listeners and then answers, held open while `hold`
   * is set so a second request meets it running. */
  function fakeDoctor(o: { code?: number; lines?: readonly (readonly [string, "out" | "err"])[]; hold?: boolean } = {}) {
    const listeners = new Set<(e: DoctorLineEvent) => void>();
    const asked: { placeId: string; doctorId: string; project?: string }[] = [];
    let release: (() => void) | undefined;
    const doctor: PlaceDoctor = {
      on: fn => {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      },
      run: async req => {
        asked.push(req);
        for (const [line, stream] of o.lines ?? []) for (const fn of [...listeners]) fn({ type: "doctor.line", doctorId: req.doctorId, line, stream });
        if (o.hold === true) await new Promise<void>(resolve => (release = resolve));
        return { code: o.code ?? 0 };
      },
    };
    return { doctor, asked, release: (): void => release?.() };
  }

  it("says every line of the road to the sockets reading events, in order and before the reply, and answers what the road exited with", async () => {
    const { doctor, asked } = fakeDoctor({ code: 1, lines: [["spoo answers", "out"], ["DOCTOR FAIL: spoo", "err"]] });
    const s = await serving(doctor);
    const c = await WsClient.connect(s.port, { token: "secret" });
    await c.request("events.subscribe");
    const reply = await c.request("places.doctor", { placeId: "p_1", doctorId: "d_1", project: "spoo-landing" });
    expect(reply).toMatchObject({ ok: true, code: 1 });
    // Both frames landed before the reply did, in the order the road said them, and neither carries a sequence:
    // the lines are a host source's and never enter the ring a client replays from.
    expect(c.events).toEqual([
      { type: "doctor.line", doctorId: "d_1", line: "spoo answers", stream: "out" },
      { type: "doctor.line", doctorId: "d_1", line: "DOCTOR FAIL: spoo", stream: "err" },
    ]);
    expect(asked).toEqual([{ placeId: "p_1", doctorId: "d_1", project: "spoo-landing" }]);
    c.close();
  });

  it("replays none of them to a socket that subscribed after the road had spoken", async () => {
    const { doctor } = fakeDoctor({ lines: [["spoo answers", "out"]] });
    const s = await serving(doctor);
    const c = await WsClient.connect(s.port, { token: "secret" });
    await c.request("events.subscribe");
    expect(await c.request("places.doctor", { placeId: "p_1", doctorId: "d_1" })).toMatchObject({ ok: true, code: 0 });
    const late = await WsClient.connect(s.port, { token: "secret" });
    expect((await late.request("events.subscribe")).ok).toBe(true);
    // A round trip after the subscription, so a frame on its way would have landed by the read below.
    expect((await late.request("places.list")).ok).toBe(true);
    expect(late.events).toEqual([]);
    c.close();
    late.close();
  });

  it("a host that wired no road refuses the op in one sentence", async () => {
    const s = await serving();
    const c = await WsClient.connect(s.port, { token: "secret" });
    expect(await c.request("places.doctor", { placeId: "p_1", doctorId: "d_1" })).toMatchObject({ ok: false, error: DOCTOR_UNSERVED });
    c.close();
  });

  it("refuses a word that names no row, and the two rows this road was never for, without reaching the road", async () => {
    const { doctor, asked } = fakeDoctor();
    const s = await serving(doctor);
    const c = await WsClient.connect(s.port, { token: "secret" });
    const rows = (await c.request("places.list"))["places"] as { id: string; name: string; kind: string }[];
    const here = rows.find(p => p.id === HERE_PLACE_ID)!;
    const cloud = rows.find(p => p.kind === "provider")!;
    expect(await c.request("places.doctor", { placeId: "p_nope", doctorId: "d_1" })).toMatchObject({ ok: false, kind: "usage", error: noSuchPlaceRefusal("p_nope", rows.map(p => p.name)) });
    expect(await c.request("places.doctor", { placeId: here.id, doctorId: "d_1" })).toMatchObject({ ok: false, kind: "usage", error: doctorRowRefusal(here.name) });
    expect(await c.request("places.doctor", { placeId: cloud.id, doctorId: "d_1" })).toMatchObject({ ok: false, kind: "usage", error: doctorRowRefusal(cloud.name) });
    expect(asked).toEqual([]);
    c.close();
  });

  it("refuses a second road on one computer while the first is still going, and runs one after it has answered", async () => {
    const { doctor, asked, release } = fakeDoctor({ hold: true });
    const s = await serving(doctor);
    const c = await WsClient.connect(s.port, { token: "secret" });
    const first = c.request("places.doctor", { placeId: "p_1", doctorId: "d_1" });
    await until(() => asked.length === 1);
    expect(await c.request("places.doctor", { placeId: "p_1", doctorId: "d_2" })).toMatchObject({ ok: false, kind: "conflict", error: doctorRunningLine("spoo") });
    release();
    expect(await first).toMatchObject({ ok: true, code: 0 });
    const again = c.request("places.doctor", { placeId: "p_1", doctorId: "d_3" });
    await until(() => asked.length === 2);
    release();
    expect(await again).toMatchObject({ ok: true, code: 0 });
    c.close();
  });

  it("a socket a thread's own token let in reads none of these lines: the event names no workspace, and that is the rule that hides it", () => {
    const runtime = rt();
    const line: DoctorLineEvent = { type: "doctor.line", doctorId: "d_1", line: "spoo answers", stream: "out" };
    expect(runtime.workspaces.seenBy(line, "here")).toBe(true);
    expect(runtime.workspaces.seenBy(line, { origin: "here", by: { kind: "thread", threadId: "t_1", workspaceId: "ws_1", rootThreadId: "t_1" } })).toBe(false);
  });
});
