// SPDX-License-Identifier: AGPL-3.0-only
// The link a place holds to its host, against a fake host that is a real ws
// server with a real ed25519 pair: nothing here fakes a signature, so the
// handshake the daemon runs is the one the host answers.
import { createPrivateKey, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { NO_PLACE_FILE_LINE, NOT_ON_THIS_ROAD, PLACE_UNKNOWN_REFUSAL, PlaceProveRequest, PlaceReport, hostKeyRefusal, hostQuietLine, linkedLine, placeDaemonPaths, placeLinkTranscript, unknownOpLine, type PlaceFile } from "@wsp/protocol";
import { freshEphemeral, makeSeal, sealKeys, sharedSecret, type Seal } from "@wsp/runtime";
import { closeFakePlaceHosts, fakePlaceHost, listening, placePair, settled, writePlaceFile } from "./fake-place-host.js";
import { daemonUnderTest, type DaemonUnderTest, type DaemonUnderTestArgs } from "./harness.js";
import { rejectedEvents } from "./wire-events.js";

const dirs: string[] = [];
const servers: WebSocketServer[] = [];
const daemons: DaemonUnderTest[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await closeFakePlaceHosts();
});

/** A fake home joined as a place: the place file and its key where a join puts them under that home. */
function placeFile(hostUrls: string[], hostPublicKey: string, keyPem: string): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), "wsp-link-"));
  dirs.push(home);
  const at = placeDaemonPaths(home);
  const file: PlaceFile = { placeId: "p_ab12cd34", name: "old-macbook", hostName: "zingzy-mbp", hostUrls, hostPublicKey, keyPath: at.placeKey, joinedAt: new Date(0).toISOString() };
  writePlaceFile(at.placeFile, file);
  writeFileSync(at.placeKey, keyPem);
  return { home, file: at.placeFile };
}

/** The daemon a place runs, dialling out on the file under its home; the token is what its own loopback door takes. */
async function placeDaemon(place: { home: string; file: string }, args: DaemonUnderTestArgs = {}): Promise<DaemonUnderTest> {
  const d = await daemonUnderTest({ host: "127.0.0.1", port: 0, token: "link-token", kind: "place", root: place.home, home: place.home, placeFile: place.file, rootsPath: placeDaemonPaths(place.home).rootsPath, ...args });
  daemons.push(d);
  return d;
}

/** Waits for one line of the daemon's log. */
const untilLogged = (d: DaemonUnderTest, test: (line: string) => boolean, timeout = 5_000): Promise<string> =>
  vi.waitFor(
    () => {
      const found = d.log().find(test);
      expect(found).toBeDefined();
      return found!;
    },
    { timeout, interval: 10 },
  );

describe("the link a place dials", () => {
  it("sends place.auth as its first frame and proves with a report the host reads, before anything else", async () => {
    const key = placePair();
    const host = await fakePlaceHost({ key });
    const place = placeFile([host.url], key.publicKey, placePair().privateKeyPem);
    // The place's own key is not the host's; the file above pins the host's, which is what it verifies against.
    const d = await placeDaemon(place, { wspArgv: ["/usr/local/bin/node", "/opt/wsp/bin.js"], agents: [{ id: "a1", bin: "sh" }, { id: "b2", bin: "no-such-agent-command" }] });
    await host.socket;
    await untilLogged(d, line => line === linkedLine(host.url));
    // The place asked nothing of the host; what the host saw after the handshake is the daemon's hello and no request.
    expect(host.frames.filter(f => "op" in f)).toEqual([]);
    // The report is the daemon's own, off the home and the words it was started with, in the shape the host parses.
    const proof = PlaceProveRequest.parse(host.proofs[0]);
    const report = PlaceReport.parse(proof.report);
    // The agents are the ids off the list it was started with whose command is on PATH now: sh is, the other is not.
    expect(report).toMatchObject({ name: "old-macbook", dialed: host.url, daemonPort: d.port, wsp: ["/usr/local/bin/node", "/opt/wsp/bin.js"], login: { HOME: place.home }, agents: ["a1"] });
    expect(report.shape.cpu).toBeGreaterThan(0);
  });

  it("dials the second address when the first refuses the connect, and names both in its log", async () => {
    const key = placePair();
    const host = await fakePlaceHost({ key });
    const dead = "http://127.0.0.1:1";
    const place = placeFile([dead, host.url], key.publicKey, placePair().privateKeyPem);
    const d = await placeDaemon(place, { linkConnectMs: 500 });
    await untilLogged(d, line => line === linkedLine(host.url));
    expect(d.log().join("\n")).toContain(dead);
    expect(d.log().join("\n")).toContain(host.url);
  });

  it("ends the attempt before it sends its report when the host's signature is over the wrong transcript", async () => {
    const key = placePair();
    const host = await fakePlaceHost({ key, wrongTranscript: true });
    const place = placeFile([host.url], key.publicKey, placePair().privateKeyPem);
    const d = await placeDaemon(place, { linkBackoffMs: 60_000 });
    await untilLogged(d, line => line === hostKeyRefusal(host.url));
    await settled(100);
    expect(host.frames).toEqual([]);
    expect(host.proofs).toEqual([]);
    expect(d.log()).not.toContain(linkedLine(host.url));
  });

  it("refuses a host whose key is not the one this computer pinned", async () => {
    const host = await fakePlaceHost();
    const place = placeFile([host.url], placePair().publicKey, placePair().privateKeyPem);
    const d = await placeDaemon(place, { linkBackoffMs: 60_000 });
    await untilLogged(d, line => line === hostKeyRefusal(host.url));
    await settled(100);
    expect(host.proofs).toEqual([]);
    expect(d.log()).not.toContain(linkedLine(host.url));
  });

  it("stops dialling for minutes when the host proves its key and says it holds no such place", async () => {
    const key = placePair();
    const host = await fakePlaceHost({ key, refuse: PLACE_UNKNOWN_REFUSAL, signRefusal: true });
    const place = placeFile([host.url], key.publicKey, placePair().privateKeyPem);
    // A backoff of milliseconds, so a refusal this computer could not prove would show a second dial at once.
    const d = await placeDaemon(place, { linkRefusedRetryMs: 600_000, linkBackoffMs: 20 });
    await untilLogged(d, line => line.includes("holds no place by that id"));
    await settled(300);
    expect(host.dials()).toBe(1);
  });

  it("keeps dialling when the refusal carries no signature the key it pinned at join made", async () => {
    const host = await fakePlaceHost({ refuse: PLACE_UNKNOWN_REFUSAL });
    const place = placeFile([host.url], placePair().publicKey, placePair().privateKeyPem);
    const d = await placeDaemon(place, { linkRefusedRetryMs: 600_000, linkBackoffMs: 20 });
    await untilLogged(d, line => line.includes("holds no place by that id"));
    // Anybody who answers at the address can send that frame, so it costs this computer the backoff and nothing more.
    await vi.waitFor(() => expect(host.dials()).toBeGreaterThan(2), { timeout: 5_000, interval: 10 });
  });

  it("says so and waits when this computer holds no place file at all", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-link-none-"));
    dirs.push(home);
    const d = await placeDaemon({ home, file: placeDaemonPaths(home).placeFile }, { linkRefusedRetryMs: 600_000 });
    await untilLogged(d, line => line === NO_PLACE_FILE_LINE);
  });

  it("says the same of a file that is not a place file, rather than dialling on what it could not read", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-link-junk-"));
    dirs.push(home);
    const at = placeDaemonPaths(home);
    mkdirSync(dirname(at.placeFile), { recursive: true, mode: 0o700 });
    writeFileSync(at.placeFile, "not a place file");
    const d = await placeDaemon({ home, file: at.placeFile }, { linkRefusedRetryMs: 600_000 });
    await untilLogged(d, line => line === NO_PLACE_FILE_LINE);
  });

  it("proves the place's own half against the key on its file, which is what the host verifies", async () => {
    const key = placePair();
    const mine = placePair();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(wss);
    let proved: boolean | undefined;
    wss.on("connection", ws => {
      ws.on("error", () => {});
      let expect1: Uint8Array | undefined;
      let seal: Seal | undefined;
      ws.on("message", raw => {
        const frame = JSON.parse(seal === undefined ? String(raw) : seal.unseal(raw as Uint8Array)) as Record<string, unknown>;
        if (frame["op"] === "place.auth") {
          const placeId = String(frame["placeId"]);
          const placeNonce = String(frame["nonce"]);
          const nonce = Buffer.alloc(32, 4).toString("base64");
          const host = freshEphemeral();
          const ephemerals = { challenger: String(frame["ephemeral"]), answerer: host.publicKey };
          expect1 = placeLinkTranscript("place", placeId, nonce, placeNonce, { challenger: host.publicKey, answerer: String(frame["ephemeral"]) });
          const signature = sign(null, placeLinkTranscript("host", placeId, placeNonce, nonce, ephemerals), createPrivateKey(key.privateKeyPem)).toString("base64");
          ws.send(JSON.stringify({ id: frame["id"], ok: true, nonce, hostPublicKey: key.publicKey, signature, ephemeral: host.publicKey }));
          seal = makeSeal(sealKeys(sharedSecret(host.privateKey, String(frame["ephemeral"])), placeId), "host");
          return;
        }
        if (frame["op"] === "place.prove") {
          proved = verify(null, expect1!, { key: Buffer.from(mine.publicKey, "base64"), format: "der", type: "spki" }, Buffer.from(String(frame["signature"]), "base64"));
          ws.send(seal!.seal(JSON.stringify({ id: frame["id"], ok: true })));
        }
      });
    });
    const port = await listening(wss);
    const place = placeFile([`http://127.0.0.1:${port}`], key.publicKey, mine.privateKeyPem);
    await placeDaemon(place);
    await vi.waitFor(() => expect(proved).toBe(true), { timeout: 5_000, interval: 10 });
  });

  it("agrees a key with the host and seals every frame after the prove, and ends the link on one sent in the clear", async () => {
    const key = placePair();
    const host = await fakePlaceHost({ key });
    const place = placeFile([host.url], key.publicKey, placePair().privateKeyPem);
    const d = await placeDaemon(place, { linkBackoffMs: 60_000 });
    const { ws, seal } = await host.socket;
    await untilLogged(d, line => line === linkedLine(host.url));
    // The prove came back inside the key the two ends agreed, which is what the host having read one means: it
    // opened the bytes the binary built with its own X25519, HKDF and AES-256-GCM.
    expect(host.frames).toEqual([]);
    expect(host.proofs).toHaveLength(1);
    expect(PlaceProveRequest.parse(host.proofs[0]).report.name).toBe("old-macbook");
    // A carrier writing into the link sends a frame this daemon would answer, in the clear; the socket ends.
    const ended = new Promise<void>(done => ws.once("close", () => done()));
    ws.send(JSON.stringify({ id: 5, op: "ping" }));
    await Promise.race([ended, settled(5_000).then(() => Promise.reject(new Error("the link stayed open on a frame nobody sealed")))]);
    expect(seal).toBeDefined();
  });

  it("cuts a link that carried no frame at all and dials again", async () => {
    const key = placePair();
    const host = await fakePlaceHost({ key });
    const place = placeFile([host.url], key.publicKey, placePair().privateKeyPem);
    const d = await placeDaemon(place, { linkQuietMs: 120, linkBackoffMs: 60_000 });
    await untilLogged(d, line => line === hostQuietLine(host.url, 0));
    // Dialling again is the backoff away, a minute here: the link is down and nothing has redialled yet.
    await settled(100);
    expect(host.dials()).toBe(1);
  });
});

describe("the socket a place proved, served as an inbound one", () => {
  it("hands the host a daemon that answers ping and pushes only frames the protocol takes", async () => {
    const key = placePair();
    const host = await fakePlaceHost({ key });
    const place = placeFile([host.url], key.publicKey, placePair().privateKeyPem);
    await placeDaemon(place);
    const { ws, seal } = await host.socket;
    const answers: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    ws.on("message", raw => {
      const f = JSON.parse(seal.unseal(raw as Uint8Array)) as Record<string, unknown>;
      if (f["type"] !== undefined) events.push(f);
      else answers.push(f);
    });
    const ask = (id: number, op: string): Promise<Record<string, unknown>> => {
      ws.send(seal.seal(JSON.stringify({ id, op })));
      return new Promise(done => {
        const at = setInterval(() => {
          const found = answers.find(a => a["id"] === id);
          if (found !== undefined) {
            clearInterval(at);
            done(found);
          }
        }, 10);
      });
    };
    expect(await ask(11, "ping")).toMatchObject({ ok: true });
    // The hello the daemon pushes the moment the socket is served, which is what tells the host what it is talking to.
    await settled(50);
    expect(events.some(e => e["type"] === "daemon.hello")).toBe(true);
    expect(rejectedEvents(events)).toEqual([]);
  });

  it("the link has no backend behind it, the door answers the listing, and an op that drives a workspace is still the link's", async () => {
    const key = placePair();
    const host = await fakePlaceHost({ key });
    const place = placeFile([host.url], key.publicKey, placePair().privateKeyPem);
    const d = await placeDaemon(place);
    const { ws, seal } = await host.socket;
    const answers: Record<string, unknown>[] = [];
    ws.on("message", raw => {
      const f = JSON.parse(seal.unseal(raw as Uint8Array)) as Record<string, unknown>;
      if (f["type"] === undefined) answers.push(f);
    });
    ws.send(seal.seal(JSON.stringify({ id: 31, op: "machine.list" })));
    const onLink = await vi.waitFor(
      () => {
        const found = answers.find(a => a["id"] === 31);
        expect(found).toBeDefined();
        return found!;
      },
      { timeout: 5_000, interval: 10 },
    );
    // A daemon with no backend names the op it cannot answer, whichever words its runtime puts around it.
    expect(onLink["ok"]).toBe(false);
    expect(String(onLink["error"])).toContain("machine.list");
    // The same op from a client holding the place's own token. The listing only reads what this computer holds, so
    // it is answered on that door whatever road it came in on: a daemon whose runtime lists answers the machines,
    // and one that lists nothing names the op it cannot answer in its own words. What neither says is the road.
    const own = new WebSocket(`ws://127.0.0.1:${d.port}`);
    const replies: Record<string, unknown>[] = [];
    await new Promise<void>((done, fail) => {
      own.on("error", fail);
      own.on("open", () => {
        own.send(JSON.stringify({ id: 1, op: "auth", token: "link-token" }));
        own.send(JSON.stringify({ id: 2, op: "machine.list" }));
        // An op that drives a workspace, on the same socket: a client on this machine does not drive its forks. A
        // daemon that knows the op refuses it by the road, one that registers none has never heard of it.
        own.send(JSON.stringify({ id: 3, op: "machine.kill", machineId: "wsp-x" }));
      });
      own.on("message", raw => {
        const f = JSON.parse(String(raw)) as Record<string, unknown>;
        if (f["type"] === undefined) replies.push(f);
        if (f["id"] === 3) done();
      });
    });
    own.close();
    const inbound = replies.find(f => f["id"] === 2)!;
    if (inbound["ok"] === true) expect(Array.isArray(inbound["machines"])).toBe(true);
    else {
      expect(String(inbound["error"])).toContain("machine.list");
      expect(inbound["error"]).not.toBe(NOT_ON_THIS_ROAD);
    }
    const drove = replies.find(f => f["id"] === 3)!;
    expect(drove["ok"]).toBe(false);
    expect([NOT_ON_THIS_ROAD, unknownOpLine("machine.kill")]).toContain(drove["error"]);
  });

  it("answers place.leave with what the sweep took and then ends the process", async () => {
    const key = placePair();
    const host = await fakePlaceHost({ key });
    const place = placeFile([host.url], key.publicKey, placePair().privateKeyPem);
    const at = placeDaemonPaths(place.home);
    // What a join and a daemon leave under the home: the token file beside the place file and its key.
    writeFileSync(at.tokenPath, "a-token\n");
    const d = await placeDaemon(place);
    const { ws, seal } = await host.socket;
    const answers: Record<string, unknown>[] = [];
    ws.on("message", raw => {
      const f = JSON.parse(seal.unseal(raw as Uint8Array)) as Record<string, unknown>;
      if (f["type"] === undefined) answers.push(f);
    });
    ws.send(seal.seal(JSON.stringify({ id: 21, op: "place.leave" })));
    const answer = await vi.waitFor(
      () => {
        const found = answers.find(a => a["id"] === 21);
        expect(found).toBeDefined();
        return found!;
      },
      { timeout: 5_000, interval: 10 },
    );
    // The sweep is the real one over that home: the place file, its key and the token are gone and named, and
    // wsp's own folder goes last and whole, so nothing of wsp's is left under the home.
    expect(answer).toMatchObject({ ok: true, swept: [at.placeFile, at.placeKey, at.tokenPath, at.wsp] });
    for (const path of [at.placeFile, at.placeKey, at.tokenPath, at.wsp]) expect(existsSync(path)).toBe(false);
    // The process ends after the reply is on the wire, and nothing dials again: the sweep took what would bring it back.
    await Promise.race([d.exited, settled(5_000).then(() => Promise.reject(new Error("the daemon did not end after the leave")))]);
    const dialed = host.dials();
    await settled(150);
    expect(host.dials()).toBe(dialed);
  });
});
