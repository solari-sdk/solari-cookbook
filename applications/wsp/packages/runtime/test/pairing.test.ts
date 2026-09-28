// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_TICKET_REFUSAL,
  ACCOUNT_UNSERVED,
  DEVICE_ACCOUNT_UNSERVED,
  DEVICE_AUTH_REFUSAL,
  DEVICE_REVOKED_REFUSAL,
  DEVICES_TICKET_REFUSAL,
  HOST_STOPPING_CLOSE,
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  PAIR_CODE_REFUSAL,
  PAIR_ISSUE_REFUSAL,
  PLACE_LINK_NONCE_BYTES,
  SEAL_CLIENT,
  SealOpenReply,
  UNAUTHORIZED,
  WS_PATH,
  deviceAdmissionTranscript,
  deviceHeldRefusal,
  placeLinkTranscript,
  type AccountDevice,
} from "@wsp/protocol";
import { freshEphemeral, makeSeal, sealKeys, sharedSecret, signPlaceBytes, verifyPlaceBytes, type PlaceKeyPair } from "@wsp/keys";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { makeDevices } from "../src/devices.js";
import { newPlaceKeyPair } from "../src/places.js";
import { serveRuntime, type AdmittedDevices, type RuntimeServer } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { keyFingerprint } from "@wsp/engine";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient, type WireMsg } from "./ws-client.js";

let srv: RuntimeServer | undefined;
let http: Server | undefined;
let second: Server | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  if (http !== undefined) await new Promise<void>(done => http!.close(() => done()));
  http = undefined;
  if (second !== undefined) await new Promise<void>(done => second!.close(() => done()));
  second = undefined;
});

/** The place wiring every host a person starts has: the code a pairing mints carries the fingerprint of the key
 * this door proves, and the computer taking that code holds the host to it. */
const hostKey = newPlaceKeyPair();
const rt = (store: Store = memoryStore()) =>
  createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: { hostKey, provider: () => undefined, here: () => ({ name: "this-mac" }), hostName: () => "this-mac" } });

async function serving(opts: { now?: () => number; store?: Store } = {}): Promise<{ store: Store }> {
  const store = opts.store ?? memoryStore();
  const runtime = rt(store);
  srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, ...(opts.now !== undefined ? { now: opts.now } : {}) });
  return { store };
}

/** A code minted over a socket holding the host's own token, which is the only road to one. */
async function codeFrom(): Promise<string> {
  const c = await WsClient.connect(srv!.port, { token: "host-token" });
  const issued = await c.request("pair.issue");
  c.close();
  expect(issued.ok, String(issued["error"])).toBe(true);
  // The fingerprint travels beside the code: the computer that types it holds this host to that key before the
  // code or a token of its own crosses.
  expect(issued["hostKey"]).toBe(keyFingerprint(hostKey.publicKey));
  return issued["code"] as string;
}

describe("pairing codes", () => {
  it("mints a single-use code of the alphabet's symbols over the host's own socket", async () => {
    await serving();
    const code = await codeFrom();
    expect(code).toHaveLength(PAIR_CODE_LENGTH);
    for (const ch of code) expect(PAIR_CODE_ALPHABET).toContain(ch);
  });

  it("refuses pair.issue on a socket nothing authed", async () => {
    await serving();
    const c = await WsClient.connect(srv!.port);
    const answer = await c.request("pair.issue");
    expect(answer.ok).toBe(false);
    expect(await c.closed()).toBe(4401);
  });

  it("refuses pair.issue on a relayed socket, whose requests came from a machine", async () => {
    await serving();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(srv!.port, { ticket });
    const answer = await relayed.request("pair.issue");
    expect(answer).toMatchObject({ ok: false, error: PAIR_ISSUE_REFUSAL });
    relayed.close();
  });

  it("refuses the device ops on a socket let in by a ticket, whichever purpose the ticket had", async () => {
    await serving();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(srv!.port, { ticket });
    expect(await relayed.request("devices.list")).toMatchObject({ ok: false, error: DEVICES_TICKET_REFUSAL });
    expect(await relayed.request("devices.revoke", { deviceId: "d_1" })).toMatchObject({ ok: false, error: DEVICES_TICKET_REFUSAL });
    relayed.close();
  });

  it("answers the account on the person's own road, refuses it on a ticket, and refuses it on a host keeping no records", async () => {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, account: { read: async () => ({ signedIn: true, login: "zingzy" }) } });
    const host = await WsClient.connect(srv.port, { token: "host-token" });
    expect(await host.request("account.get")).toMatchObject({ ok: true, account: { signedIn: true, login: "zingzy" } });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(srv.port, { ticket });
    expect(await relayed.request("account.get")).toMatchObject({ ok: false, error: ACCOUNT_TICKET_REFUSAL });
    relayed.close();
    await srv.close();

    const bare = rt();
    srv = await serveRuntime(bare, { port: 0, authToken: "host-token", devices: bare.devices });
    const alone = await WsClient.connect(srv.port, { token: "host-token" });
    expect(await alone.request("account.get")).toMatchObject({ ok: false, error: ACCOUNT_UNSERVED });
    alone.close();
  });

  it("refuses pair.issue on a socket holding a device token: a paired computer cannot pair another", async () => {
    await serving();
    const code = await codeFrom();
    const client = await WsClient.connect(srv!.port);
    const paired = await client.request("pair.redeem", { code, name: "laptop" });
    const answer = await client.request("pair.issue");
    expect(paired.ok).toBe(true);
    // The device door reads the op before the switch does, so a paired computer meets the door's own sentence.
    expect(answer).toMatchObject({ ok: false, error: deviceHeldRefusal("pair.issue") });
    client.close();
  });

  it("redeems a code once as the first frame of an unauthed socket, and refuses the second redeem", async () => {
    await serving();
    const code = await codeFrom();
    const first = await WsClient.connect(srv!.port);
    const got = await first.request("pair.redeem", { code, name: "laptop" });
    expect(got.ok).toBe(true);
    expect(typeof got["deviceToken"]).toBe("string");
    expect(typeof got["deviceId"]).toBe("string");
    // The socket is authed from that frame on: an op that needs auth answers rather than closing it.
    expect((await first.request("workspaces.list")).ok).toBe(true);
    first.close();

    const second = await WsClient.connect(srv!.port);
    const again = await second.request("pair.redeem", { code, name: "another" });
    expect(again).toMatchObject({ ok: false, error: PAIR_CODE_REFUSAL });
    expect(await second.closed()).toBe(4401);
  });

  it("refuses an expired code and forgets it, so a later clock does not let it in", async () => {
    let clock = 1_000;
    const { store } = await serving({ now: () => clock });
    const code = await codeFrom();
    expect(await store.get("pairings", code)).toBeDefined();
    clock += 11 * 60_000;
    const late = await WsClient.connect(srv!.port);
    const answer = await late.request("pair.redeem", { code, name: "laptop" });
    expect(answer).toMatchObject({ ok: false, error: PAIR_CODE_REFUSAL });
    expect(await store.get("pairings", code)).toBeUndefined();
    expect(await late.closed()).toBe(4401);
  });

  it("clears codes that ran out when the next one is minted, so the state file keeps no dead ones", async () => {
    let clock = 1_000;
    const { store } = await serving({ now: () => clock });
    const stale = await codeFrom();
    clock += 11 * 60_000;
    const fresh = await codeFrom();
    expect(await store.get("pairings", stale)).toBeUndefined();
    expect(await store.get("pairings", fresh)).toBeDefined();
  });

  it("keeps only the token's hash, never the token", async () => {
    const { store } = await serving();
    const code = await codeFrom();
    const client = await WsClient.connect(srv!.port);
    const { deviceToken } = (await client.request("pair.redeem", { code, name: "laptop" })) as { deviceToken: string };
    client.close();
    expect(JSON.stringify(await store.list("devices"))).not.toContain(deviceToken);
  });
});

describe("the code wsp init mints for the browser it opens", () => {
  /** What the runtime is handed as the caller of a listing: the one reading of a socket's road. */
  const roadsSeen = (runtime: Runtime): (unknown | undefined)[] => {
    const seen: (unknown | undefined)[] = [];
    const list = runtime.workspaces.list.bind(runtime.workspaces);
    vi.spyOn(runtime.workspaces, "list").mockImplementation(async caller => {
      seen.push(caller);
      return list(caller);
    });
    return seen;
  };

  it("admits a device listed here, whose socket takes the person's own road where a device from a plain code is a paired computer", async () => {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const seen = roadsSeen(runtime);
    const host = await WsClient.connect(srv.port, { token: "host-token" });
    const here = (await host.request("pair.issue", { here: true }))["code"] as string;
    const plain = (await host.request("pair.issue"))["code"] as string;

    const browser = await WsClient.connect(srv.port);
    const admitted = (await browser.request("pair.redeem", { code: here, name: "a Mac in a browser" })) as { ok: boolean; deviceId: string; deviceToken: string };
    expect(admitted.ok).toBe(true);
    expect((await browser.request("workspaces.list")).ok).toBe(true);
    const laptop = await WsClient.connect(srv.port);
    const paired = (await laptop.request("pair.redeem", { code: plain, name: "laptop" })) as { ok: boolean; deviceId: string };
    expect(paired.ok).toBe(true);
    expect((await laptop.request("workspaces.list")).ok).toBe(true);
    // The road each socket is handed: nobody in particular for the owner's browser, a paired computer for the laptop.
    expect(seen).toEqual([undefined, "paired"]);

    // The listing says which is which, and the bit survives the redeem into the token's next auth frame.
    const { devices } = (await host.request("devices.list")) as { devices: { id: string; here?: true }[] };
    expect(devices.map(d => [d.id, d.here])).toEqual([
      [admitted.deviceId, true],
      [paired.deviceId, undefined],
    ]);
    const back = await WsClient.connect(srv.port, { token: admitted.deviceToken });
    expect((await back.request("workspaces.list")).ok).toBe(true);
    expect(seen.at(-1)).toBeUndefined();
    for (const c of [host, browser, laptop, back]) c.close();
  });

  it("is minted only over a socket holding the host's own token: the owner's browser cannot mint one, nor can a laptop", async () => {
    await serving();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const here = (await host.request("pair.issue", { here: true }))["code"] as string;
    const browser = await WsClient.connect(srv!.port);
    expect((await browser.request("pair.redeem", { code: here, name: "a Mac in a browser" })).ok).toBe(true);
    expect(await browser.request("pair.issue", { here: true })).toMatchObject({ ok: false, error: PAIR_ISSUE_REFUSAL });
    expect(await browser.request("pair.issue")).toMatchObject({ ok: false, error: PAIR_ISSUE_REFUSAL });
    const laptop = await WsClient.connect(srv!.port);
    expect((await laptop.request("pair.redeem", { code: await codeFrom(), name: "laptop" })).ok).toBe(true);
    expect(await laptop.request("pair.issue", { here: true })).toMatchObject({ ok: false, error: deviceHeldRefusal("pair.issue") });
    // A spent code is spent: the second browser to try it is refused.
    const again = await WsClient.connect(srv!.port);
    expect(await again.request("pair.redeem", { code: here, name: "another" })).toMatchObject({ ok: false, error: PAIR_CODE_REFUSAL });
    for (const c of [host, browser, laptop]) c.close();
  });

  it("is revoked like every other device, and its socket is cut with it", async () => {
    await serving();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const here = (await host.request("pair.issue", { here: true }))["code"] as string;
    const browser = await WsClient.connect(srv!.port);
    const { deviceId, deviceToken } = (await browser.request("pair.redeem", { code: here, name: "a Mac in a browser" })) as { deviceId: string; deviceToken: string };
    const cut = browser.closed();
    expect(await host.request("devices.revoke", { deviceId })).toMatchObject({ ok: true, revoked: true });
    expect(await cut).toBe(4401);
    expect(await srv!.authorize(deviceToken)).toBeUndefined();
    host.close();
  });
});

describe("device tokens on the auth frame", () => {
  it("takes a device token, still takes the host's own, and refuses a revoked one with 4401", async () => {
    await serving();
    const code = await codeFrom();
    const paired = await WsClient.connect(srv!.port);
    const { deviceToken, deviceId } = (await paired.request("pair.redeem", { code, name: "laptop" })) as { deviceToken: string; deviceId: string };
    paired.close();

    const again = await WsClient.connect(srv!.port, { token: deviceToken });
    expect((await again.request("workspaces.list")).ok).toBe(true);
    again.close();

    const asHost = await WsClient.connect(srv!.port, { token: "host-token" });
    expect((await asHost.request("devices.revoke", { deviceId })).ok).toBe(true);
    asHost.close();

    const refused = await WsClient.connect(srv!.port);
    void refused.request("auth", { token: deviceToken });
    expect(await refused.closed()).toBe(4401);

    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    expect((await host.request("workspaces.list")).ok).toBe(true);
    host.close();
  });

  it("cuts the sockets a revoked device still holds", async () => {
    await serving();
    const code = await codeFrom();
    const device = await WsClient.connect(srv!.port);
    const { deviceId } = (await device.request("pair.redeem", { code, name: "laptop" })) as { deviceId: string };
    const cut = device.closed();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    await host.request("devices.revoke", { deviceId });
    expect(await cut).toBe(4401);
    host.close();
  });
});

describe("the device listing", () => {
  it("names each device and moves its last seen when it auths again", async () => {
    let clock = Date.parse("2026-09-11T10:00:00.000Z");
    await serving({ now: () => clock });
    const code = await codeFrom();
    const first = await WsClient.connect(srv!.port);
    const { deviceToken } = (await first.request("pair.redeem", { code, name: "maya's laptop" })) as { deviceToken: string };
    first.close();

    const paired = new Date(clock).toISOString();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const before = (await host.request("devices.list")) as { devices: { name: string; createdAt: string; lastSeenAt: string }[] };
    expect(before.devices.map(d => d.name)).toEqual(["maya's laptop"]);
    // The redeem is itself the first time this computer was seen, so the row reads the same on both counts.
    expect(before.devices[0]).toMatchObject({ createdAt: paired, lastSeenAt: paired });

    clock += 60_000;
    const back = await WsClient.connect(srv!.port, { token: deviceToken });
    back.close();
    // The auth frame's own reply does not wait on the write, so the listing is polled rather than read once.
    const moved = new Date(clock).toISOString();
    await until(async () => {
      const { devices } = (await host.request("devices.list")) as { devices: { lastSeenAt: string }[] };
      return devices[0]!.lastSeenAt === moved;
    });

    // A JSON route reading the same token must not move it: a write per request would rewrite the state file.
    clock += 60_000;
    expect(await srv!.authorize(deviceToken)).toMatchObject({ kind: "device" });
    const unmoved = (await host.request("devices.list")) as { devices: { lastSeenAt: string }[] };
    expect(unmoved.devices[0]!.lastSeenAt).not.toBe(new Date(clock).toISOString());
    host.close();
  });

  it("lets a paired device revoke another device and cuts that device's socket, as it lets it revoke itself", async () => {
    await serving();
    const one = await WsClient.connect(srv!.port);
    const { deviceId: oneId } = (await one.request("pair.redeem", { code: await codeFrom(), name: "one" })) as { deviceId: string };
    const two = await WsClient.connect(srv!.port);
    const { deviceId: twoId } = (await two.request("pair.redeem", { code: await codeFrom(), name: "two" })) as { deviceId: string };
    const three = await WsClient.connect(srv!.port);
    const { deviceId: threeId } = (await three.request("pair.redeem", { code: await codeFrom(), name: "three" })) as { deviceId: string };

    // The laptop a person holds is where they cut a token they lost elsewhere: another device's revoke lands, and
    // the socket that device held is cut with it.
    const twoCut = two.closed();
    expect(await one.request("devices.revoke", { deviceId: twoId })).toMatchObject({ ok: true, revoked: true });
    expect(await twoCut).toBe(4401);
    // A device still hands its own back.
    expect(await three.request("devices.revoke", { deviceId: threeId })).toMatchObject({ ok: true, revoked: true });
    // An id nothing is paired under reads as nothing to take, whoever asks.
    expect(await one.request("devices.revoke", { deviceId: "d_nope" })).toMatchObject({ ok: true, revoked: false });

    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const { devices } = (await host.request("devices.list")) as { devices: { id: string }[] };
    expect(devices.map(d => d.id)).toEqual([oneId]);
    // A paired device reads the list too, and the browser wsp init let in reads and cuts like any other.
    expect(((await one.request("devices.list")) as { devices: { id: string }[] }).devices.map(d => d.id)).toEqual([oneId]);
    host.close();
    one.close();
  });
});

describe("the runtime on an HTTP server's own port", () => {
  async function attached(): Promise<number> {
    const runtime = rt();
    http = createServer((_req, res) => res.end("page"));
    await new Promise<void>(done => http!.listen(0, "127.0.0.1", done));
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", attach: http, devices: runtime.devices });
    return (http.address() as { port: number }).port;
  }

  it("answers on WS_PATH of the attached server and on its own port", async () => {
    const port = await attached();
    const onPath = await WsClient.connectTo(`ws://127.0.0.1:${port}${WS_PATH}`, { token: "host-token" });
    expect((await onPath.request("workspaces.list")).ok).toBe(true);
    onPath.close();
    const onPort = await WsClient.connect(srv!.port, { token: "host-token" });
    expect((await onPort.request("workspaces.list")).ok).toBe(true);
    onPort.close();
  });

  it("answers on both attached servers, since the app's own port and the door computers you own dial carry one protocol", async () => {
    const runtime = rt();
    http = createServer((_req, res) => res.end("page"));
    second = createServer((_req, res) => res.end("page"));
    for (const server of [http, second]) await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", attach: [http, second], devices: runtime.devices });
    const ports = [http, second].map(server => (server.address() as { port: number }).port);
    for (const port of ports) {
      const on = await WsClient.connectTo(`ws://127.0.0.1:${port}${WS_PATH}`, { token: "host-token" });
      expect((await on.request("workspaces.list")).ok).toBe(true);
      on.close();
      await expect(WsClient.connectTo(`ws://127.0.0.1:${port}/socket`, {})).rejects.toThrow();
    }
    await srv.close();
    srv = undefined;
    // A close takes the runtime off both, so neither server is left upgrading into a runtime that has stopped.
    for (const port of ports) await expect(WsClient.connectTo(`ws://127.0.0.1:${port}${WS_PATH}`, {})).rejects.toThrow();
  });

  it("refuses an upgrade of any other path rather than answering it", async () => {
    const port = await attached();
    await expect(WsClient.connectTo(`ws://127.0.0.1:${port}/socket`, {})).rejects.toThrow();
  });

  it("survives a peer that resets right after an upgrade it refuses, which nothing else would catch", async () => {
    const port = await attached();
    const faults: unknown[] = [];
    const catchIt = (e: unknown): void => void faults.push(e);
    process.on("uncaughtException", catchIt);
    try {
      // The refusal writes to a raw socket the ws library never wrapped; without an error listener on it a reset
      // here reaches the process, and a host bound beyond loopback would be ended by a stranger knocking.
      for (let i = 0; i < 30; i++) {
        await new Promise<void>(done => {
          const sock = connect({ port, host: "127.0.0.1" }, () => {
            sock.write(`GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
            sock.resetAndDestroy();
            done();
          });
          sock.on("error", () => done());
        });
      }
      // Long enough for every reset to land on the host's side of the socket.
      await new Promise(r => setTimeout(r, 500));
      expect(faults).toEqual([]);
    } finally {
      process.off("uncaughtException", catchIt);
    }
    // The host is still answering after all of it.
    const alive = await WsClient.connectTo(`ws://127.0.0.1:${port}${WS_PATH}`, { token: "host-token" });
    expect((await alive.request("workspaces.list")).ok).toBe(true);
    alive.close();
  });

  it("closes a client on WS_PATH with the stopping code, not by cutting the socket", async () => {
    const port = await attached();
    const client = await WsClient.connectTo(`ws://127.0.0.1:${port}${WS_PATH}`, { token: "host-token" });
    const closed = client.closed();
    await srv!.close();
    srv = undefined;
    expect(await closed).toBe(HOST_STOPPING_CLOSE);
  });
});

describe("one writer over the device records", () => {
  it("a revoke that lands while a last seen write is in flight stays revoked", async () => {
    const store = memoryStore();
    const door = makeDevices(store);
    const { code } = await door.issue({ now: 1_000, ttlMs: 60_000 });
    const paired = (await door.redeem(code, "laptop", 1_000))!;

    // What a paired client redialing with backoff does while somebody at the host runs wsp host devices revoke: both
    // roads read the record, and without one writer the later write puts the revoked device back.
    const [, revoked] = await Promise.all([door.seen(paired.deviceId, 2_000), door.revoke(paired.deviceId)]);
    expect(revoked).toBe(true);
    expect(await door.list()).toEqual([]);
    expect(await door.match(paired.deviceToken)).toBeUndefined();
    expect(await store.get("devices", paired.deviceId)).toBeUndefined();
  });

  it("holds in the other order too, and a seen after a revoke writes nothing back", async () => {
    const store = memoryStore();
    const door = makeDevices(store);
    const { code } = await door.issue({ now: 1_000, ttlMs: 60_000 });
    const paired = (await door.redeem(code, "laptop", 1_000))!;
    const [revoked, moved] = await Promise.all([door.revoke(paired.deviceId), door.seen(paired.deviceId, 2_000)]);
    expect(revoked).toBe(true);
    expect(moved).toBeUndefined();
    expect(await door.list()).toEqual([]);
  });

  it("two sockets spending one code get one device between them", async () => {
    const store = memoryStore();
    const door = makeDevices(store);
    const { code } = await door.issue({ now: 1_000, ttlMs: 60_000 });
    const both = await Promise.all([door.redeem(code, "one", 1_000), door.redeem(code, "two", 1_000)]);
    expect(both.filter(p => p !== undefined)).toHaveLength(1);
    expect(await door.list()).toHaveLength(1);
  });
});

describe("a runtime served with no device door", () => {
  it("refuses a pair.redeem first frame in one line rather than leaving the socket open", async () => {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token" });
    const client = await WsClient.connect(srv.port);
    const answer = await client.request("pair.redeem", { code: "AAAAAAAA", name: "laptop" });
    expect(answer).toMatchObject({ ok: false, error: PAIR_CODE_REFUSAL, kind: "auth" });
    expect(await client.closed()).toBe(4401);
  });

  it("still takes the host's own token, so a runtime without one is unchanged", async () => {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token" });
    const client = await WsClient.connect(srv.port, { token: "host-token" });
    expect((await client.request("workspaces.list")).ok).toBe(true);
    client.close();
  });
});

describe("who a bearer token names", () => {
  it("answers host for the host's own, the device for a paired one, and nothing for anything else", async () => {
    await serving();
    const code = await codeFrom();
    const client = await WsClient.connect(srv!.port);
    const { deviceToken, deviceId } = (await client.request("pair.redeem", { code, name: "laptop" })) as { deviceToken: string; deviceId: string };
    client.close();
    expect(await srv!.authorize("host-token")).toEqual({ kind: "host" });
    expect(await srv!.authorize(deviceToken)).toMatchObject({ kind: "device", device: { id: deviceId } });
    expect(await srv!.authorize("nope")).toBeUndefined();
    expect(await srv!.authorize(undefined)).toBeUndefined();
  });
});

describe("a computer the account admitted", () => {
  /** The wsp on a computer the host was linked from: the key it signs an admission with, which the host holds the
   * fingerprint and the public half of in its own record. */
  const laptopKey = newPlaceKeyPair();
  const signerKey = newPlaceKeyPair();
  const strangerKey = newPlaceKeyPair();

  const keyOf = (pair: PlaceKeyPair): { fingerprint: string; publicKey: string } => ({ fingerprint: keyFingerprint(pair.publicKey), publicKey: pair.publicKey });

  /** One admission, as a wsp already in signs it and as the relay carries it: no host is inside the bytes, so one
   * stands at every host that trusts the signer. */
  const admissionBy = (pair: PlaceKeyPair, device: string, issuedAt = "2026-09-22T00:00:00.000Z"): { by: string; issuedAt: string; signature: string } => {
    const by = keyFingerprint(pair.publicKey);
    return { by, issuedAt, signature: signPlaceBytes(pair.privateKeyPem, deviceAdmissionTranscript(device, by, issuedAt)) };
  };

  const accountDevice = (pair: PlaceKeyPair, admissions: { by: string; issuedAt: string; signature: string }[], id = "c_laptop"): AccountDevice => ({
    id,
    name: "the laptop",
    fingerprint: keyFingerprint(pair.publicKey),
    admissions,
  });

  /** What the host reads of the account: the key it trusts, the listing its last beat learned, and the one extra
   * beat a miss asks for, counted here so a case can say what a miss cost. */
  function account(opts: { signer?: PlaceKeyPair; devices?: AccountDevice[]; onRefresh?: () => AccountDevice[] | undefined } = {}): AdmittedDevices & { refreshes: number } {
    let listed = opts.devices;
    const door = {
      refreshes: 0,
      signer: () => (opts.signer === undefined ? undefined : keyOf(opts.signer)),
      list: () => listed,
      refresh: async () => {
        door.refreshes += 1;
        const learned = opts.onRefresh?.();
        if (learned !== undefined) listed = learned;
        await Promise.resolve();
      },
    };
    return door;
  }

  async function servingAccount(admitted: AdmittedDevices): Promise<Runtime> {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, admitted });
    return runtime;
  }

  /** What a native client does before it says who it is: the key agreement, checked, and the bytes its own
   * signature has to cover, which are the transcript the host kept for the frame that follows. */
  async function openSeal(c: WsClient): Promise<Uint8Array> {
    const mine = freshEphemeral();
    const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
    const reply = SealOpenReply.parse(await c.request("seal.open", { nonce, ephemeral: mine.publicKey }));
    expect(verifyPlaceBytes(reply.hostPublicKey, placeLinkTranscript("host", SEAL_CLIENT, nonce, reply.nonce, { challenger: mine.publicKey, answerer: reply.ephemeral }), reply.signature)).toBe(true);
    c.seal = makeSeal(sealKeys(sharedSecret(mine.privateKey, reply.ephemeral), SEAL_CLIENT), "place");
    return placeLinkTranscript("place", SEAL_CLIENT, reply.nonce, nonce, { challenger: reply.ephemeral, answerer: mine.publicKey });
  }

  /** One dial of a computer coming in through the account: the seal, then the key it proves and its signature over
   * that seal's own transcript. `sign` is what a case bends to send a signature over other bytes. */
  async function dialWith(pair: PlaceKeyPair, opts: { name?: string; sign?: (expect: Uint8Array) => string } = {}): Promise<{ client: WsClient; answer: WireMsg }> {
    const client = await WsClient.connect(srv!.port);
    const expect = await openSeal(client);
    const answer = await client.request("device.auth", {
      publicKey: pair.publicKey,
      name: opts.name ?? "the laptop",
      signature: opts.sign === undefined ? signPlaceBytes(pair.privateKeyPem, expect) : opts.sign(expect),
    });
    return { client, answer };
  }

  it("admits a computer whose key the account lists with an admission signed by the key this host trusts, and records the road it came by", async () => {
    const runtime = await servingAccount(account({ signer: signerKey, devices: [accountDevice(laptopKey, [admissionBy(signerKey, keyFingerprint(laptopKey.publicKey))])] }));
    const { client, answer } = await dialWith(laptopKey);
    expect(answer.ok, String(answer["error"])).toBe(true);
    const deviceToken = answer["deviceToken"] as string;
    // The socket is that device from the reply on, and it is a paired computer at the door: an account device is
    // read exactly as one that redeemed a code.
    expect((await client.request("workspaces.list")).ok).toBe(true);
    expect(await client.request("workspaces.exec", { workspaceId: "ws_1", command: "ls" })).toMatchObject({ ok: false, error: deviceHeldRefusal("workspaces.exec") });
    client.close();
    const [device] = await runtime.devices.list();
    expect(device).toMatchObject({
      name: "the laptop",
      via: { kind: "account", relayDeviceId: "c_laptop", fingerprint: keyFingerprint(laptopKey.publicKey), publicKey: laptopKey.publicKey, admittedBy: keyFingerprint(signerKey.publicKey) },
    });
    // The token it was handed is one this host takes on the ordinary road, as a redeemed one is.
    expect(await srv!.authorize(deviceToken)).toMatchObject({ kind: "device", device: { id: device!.id } });
  });

  it("admits a computer an already admitted one signed for, and never one signed by a key it has not seen", async () => {
    const runtime = await servingAccount(
      account({
        signer: signerKey,
        devices: [
          accountDevice(laptopKey, [admissionBy(signerKey, keyFingerprint(laptopKey.publicKey))]),
          accountDevice(strangerKey, [admissionBy(laptopKey, keyFingerprint(strangerKey.publicKey))], "c_desk"),
        ],
      }),
    );
    const first = await dialWith(laptopKey);
    expect(first.answer.ok).toBe(true);
    first.client.close();
    // The laptop's own key is one this host saw at an admission, so what it signs stands here too.
    const second = await dialWith(strangerKey, { name: "the desk" });
    expect(second.answer.ok, String(second.answer["error"])).toBe(true);
    second.client.close();
    expect((await runtime.devices.list()).map(d => d.via?.admittedBy)).toEqual([keyFingerprint(signerKey.publicKey), keyFingerprint(laptopKey.publicKey)]);
  });

  it("refuses in one sentence a key the account does not list, a computer no admission names, an admission signed by a key it does not trust and one whose signature does not stand", async () => {
    const trusted = admissionBy(signerKey, keyFingerprint(laptopKey.publicKey));
    const runtime = await servingAccount(
      account({
        signer: signerKey,
        devices: [
          accountDevice(laptopKey, []),
          accountDevice(strangerKey, [admissionBy(strangerKey, keyFingerprint(strangerKey.publicKey))], "c_desk"),
          // The signer this host trusts, over bytes that are not this device's: the fingerprints line up and the
          // signature does not.
          accountDevice(signerKey, [{ ...trusted, signature: trusted.signature }], "c_own"),
        ],
      }),
    );
    // A key nothing on the account holds.
    const unlisted = await dialWith(newPlaceKeyPair());
    expect(unlisted.answer).toMatchObject({ ok: false, error: DEVICE_AUTH_REFUSAL, kind: "auth" });
    expect(await unlisted.client.closed()).toBe(4401);
    // On the list and admitted by nobody.
    const bare = await dialWith(laptopKey);
    expect(bare.answer).toMatchObject({ ok: false, error: DEVICE_AUTH_REFUSAL, kind: "auth" });
    // Admitted by a key this host never saw: a device can sign for itself and get in nowhere.
    const itself = await dialWith(strangerKey, { name: "the desk" });
    expect(itself.answer).toMatchObject({ ok: false, error: DEVICE_AUTH_REFUSAL, kind: "auth" });
    // The signer's own bytes, over another device's fingerprint.
    const bent = await dialWith(signerKey, { name: "the mac" });
    expect(bent.answer).toMatchObject({ ok: false, error: DEVICE_AUTH_REFUSAL, kind: "auth" });
    expect(await runtime.devices.list()).toEqual([]);
  });

  it("refuses a device signature that does not cover the seal this socket agreed, so an admission alone opens nothing", async () => {
    const runtime = await servingAccount(account({ signer: signerKey, devices: [accountDevice(laptopKey, [admissionBy(signerKey, keyFingerprint(laptopKey.publicKey))])] }));
    const elsewhere = await dialWith(laptopKey, { sign: () => signPlaceBytes(laptopKey.privateKeyPem, new TextEncoder().encode("another socket's bytes")) });
    expect(elsewhere.answer).toMatchObject({ ok: false, error: DEVICE_AUTH_REFUSAL, kind: "auth" });
    expect(await runtime.devices.list()).toEqual([]);
  });

  it("remembers the key of a device it revoked and admits it no more, whatever admission the account still carries", async () => {
    const runtime = await servingAccount(account({ signer: signerKey, devices: [accountDevice(laptopKey, [admissionBy(signerKey, keyFingerprint(laptopKey.publicKey))])] }));
    const first = await dialWith(laptopKey);
    expect(first.answer.ok).toBe(true);
    const id = first.answer["deviceId"] as string;
    first.client.close();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    expect(await host.request("devices.revoke", { deviceId: id })).toMatchObject({ ok: true, revoked: true });
    host.close();
    const again = await dialWith(laptopKey);
    expect(again.answer).toMatchObject({ ok: false, error: DEVICE_REVOKED_REFUSAL, kind: "auth" });
    expect(await runtime.devices.list()).toEqual([]);
    // The memory is the key, not the id the relay minted: the same computer signing in again is refused too.
    expect(await runtime.devices.refuses(keyFingerprint(laptopKey.publicKey))).toBe(true);
  });

  it("asks the host for one more beat when the key is not on the list yet, and admits what that beat learned", async () => {
    const approved = accountDevice(laptopKey, [admissionBy(signerKey, keyFingerprint(laptopKey.publicKey))]);
    const door = account({ signer: signerKey, devices: [], onRefresh: () => [approved] });
    await servingAccount(door);
    const { client, answer } = await dialWith(laptopKey);
    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(door.refreshes).toBe(1);
    client.close();
  });

  it("refuses device.auth on a host that is on no account, and on a socket that agreed no key", async () => {
    await servingAccount(account({ devices: [] }));
    const unlinked = await dialWith(laptopKey);
    expect(unlinked.answer).toMatchObject({ ok: false, error: DEVICE_ACCOUNT_UNSERVED, kind: "auth" });
    await srv!.close();

    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, admitted: account({ signer: signerKey, devices: [accountDevice(laptopKey, [admissionBy(signerKey, keyFingerprint(laptopKey.publicKey))])] }) });
    const bare = await WsClient.connect(srv.port);
    const answer = await bare.request("device.auth", { publicKey: laptopKey.publicKey, name: "the laptop", signature: signPlaceBytes(laptopKey.privateKeyPem, new TextEncoder().encode("no seal")) });
    expect(answer).toMatchObject({ ok: false, error: UNAUTHORIZED, kind: "auth" });
  });

  it("refuses device.auth on a socket already through the door, which is a second identity", async () => {
    await servingAccount(account({ signer: signerKey, devices: [accountDevice(laptopKey, [admissionBy(signerKey, keyFingerprint(laptopKey.publicKey))])] }));
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    expect(await host.request("device.auth", { publicKey: laptopKey.publicKey, name: "the laptop", signature: signPlaceBytes(laptopKey.privateKeyPem, new TextEncoder().encode("x")) })).toMatchObject({ ok: false, error: DEVICE_AUTH_REFUSAL });
    host.close();
  });
});
