// SPDX-License-Identifier: AGPL-3.0-only
// The daemon channel over the runtime's own socket: a real daemon binary
// behind a stub machine whose route names it, driven through WsClient the way
// a page drives the host.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalBackend } from "@wsp/engine";
import { fakeProcTree } from "../../daemon/test/fake-proc.js";
import { daemonUnderTest, machineDaemonToken, type DaemonUnderTest } from "../../daemon/test/harness.js";
import { HERE_PLACE_ID, PLACES_TICKET_REFUSAL, relayedRefusal, rootsPathIn } from "@wsp/protocol";
import { DAEMON_TOKEN_PATH } from "@wsp/protocol";
import { DAEMON_TOKEN_NONE, DAEMON_TOKEN_SET } from "../src/daemon-token.js";
import { localExecStream } from "../src/local-exec.js";
import { createRuntime, type LocalWiring, type Runtime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { startRefusingDoor, type RefusingDoor } from "./refusing-door.js";
import { stubBackend, tokenGuest, type StubBackend, copyingFake, createOn, projectOn, testPlatform } from "./stub-backend.js";
import { startTcpProxy, type TcpProxy } from "./tcp-proxy.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

const HOST_TOKEN = "secret";
const DAEMON_TOKEN = "cafef00d".repeat(3);
/** The same guest with its token file gone: the machine runs and there is no daemon on it to reach. */
const noDaemonGuest = (_m: unknown, cmd: string) => (cmd.includes(DAEMON_TOKEN_PATH) ? { exitCode: 0, stdout: `${DAEMON_TOKEN_NONE}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });

let srv: RuntimeServer | undefined;
let rt: Runtime | undefined;
let daemon: DaemonUnderTest | undefined;
let proxy: TcpProxy | undefined;
let door: RefusingDoor | undefined;
let inboxDir: string | undefined;
let procRoot: string | undefined;
let localRoot: string | undefined;

const MACHINE_TOKEN = machineDaemonToken(DAEMON_TOKEN, "m1");

async function startTestDaemon(token = MACHINE_TOKEN): Promise<DaemonUnderTest> {
  inboxDir = mkdtempSync(join(tmpdir(), "wsp-serve-daemon-"));
  procRoot = fakeProcTree([]);
  return daemonUnderTest({ host: "127.0.0.1", port: 0, token, inbox: inboxDir, rootsPath: rootsPathIn(inboxDir), procRoot, portsIntervalMs: 1000 });
}

/** A served runtime whose one workspace's machine reaches `url`; the reply is the workspace id. */
async function served(url: string, opts: { execImpl?: StubBackend["execImpl"] } = {}): Promise<{ backend: StubBackend; workspaceId: string }> {
  const backend = stubBackend();
  backend.execImpl = opts.execImpl ?? tokenGuest;
  rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN });
  srv = await serveRuntime(rt, { port: 0, authToken: HOST_TOKEN });
  const ws = await createOn(rt, { golden: "snap_g", name: "x" });
  backend.machines[0]!.previewUrl = async () => ({ url, token: "e", expiresAt: Date.now() + 3_600_000 });
  return { backend, workspaceId: ws.id };
}

const client = (): Promise<WsClient> => WsClient.connect(srv!.port, { token: HOST_TOKEN });

const framesOn = (c: WsClient, channel: string, type: string): Record<string, unknown>[] =>
  c.events.filter(e => e.type === type && e["channel"] === channel) as Record<string, unknown>[];

afterEach(async () => {
  await srv?.close();
  srv = undefined;
  await rt?.close();
  rt = undefined;
  await proxy?.close();
  proxy = undefined;
  await door?.close();
  door = undefined;
  await daemon?.close();
  daemon = undefined;
  if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  inboxDir = undefined;
  if (procRoot) rmSync(procRoot, { recursive: true, force: true });
  procRoot = undefined;
  if (localRoot) rmSync(localRoot, { recursive: true, force: true });
  localRoot = undefined;
});

describe("daemon.open", () => {
  it("replies with a channel and pushes the daemon's hello to the socket that asked and to nobody else", async () => {
    daemon = await startTestDaemon();
    const { workspaceId } = await served(`ws://127.0.0.1:${daemon.port}`);
    const mine = await client();
    const quiet = await client();
    const opened = await mine.request("daemon.open", { workspaceId });
    expect(opened.ok).toBe(true);
    const channel = String(opened["channel"]);
    expect(channel).not.toBe("");

    await until(() => framesOn(mine, channel, "daemon.event").length > 0);
    expect(framesOn(mine, channel, "daemon.event")[0]!["event"]).toMatchObject({ type: "daemon.hello" });
    expect(quiet.events).toEqual([]);
    mine.close();
    quiet.close();
  }, 15_000);

  it("writes a machine's daemon token where that machine keeps it, and at the guest's own path where it names none", async () => {
    daemon = await startTestDaemon();
    const ownPath = "/tmp/stand-in/fk_c0ffee/.wsp-daemon-token";
    // A stand-in machine's guest is a folder on the computer asking, so a shell there cannot write the path a
    // Linux fork keeps its token at, and the whole daemon road would come back without one.
    const { backend, workspaceId } = await served(`ws://127.0.0.1:${daemon.port}`, {
      execImpl: (_m, cmd) => (cmd.includes(ownPath) ? { exitCode: 0, stdout: `${DAEMON_TOKEN_SET}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }),
    });
    Object.assign(backend.machines[0]!, { daemonTokenPath: ownPath });
    const c = await client();
    expect((await c.request("daemon.open", { workspaceId })).ok).toBe(true);
    const asked = backend.machines[0]!.execLog.filter(cmd => cmd.includes(".wsp-daemon-token"));
    expect(asked.some(cmd => cmd.includes(ownPath))).toBe(true);
    expect(asked.some(cmd => cmd.includes(DAEMON_TOKEN_PATH))).toBe(false);
    c.close();
  }, 15_000);

  it("carries the daemon's own refusal under an ok reply, and keeps a channel's events off another channel", async () => {
    daemon = await startTestDaemon();
    const { workspaceId } = await served(`ws://127.0.0.1:${daemon.port}`);
    const c = await client();
    const first = String((await c.request("daemon.open", { workspaceId }))["channel"]);
    const second = String((await c.request("daemon.open", { workspaceId }))["channel"]);
    expect(second).not.toBe(first);

    const created = await c.request("daemon.send", { channel: first, frame: { op: "pty.create", cols: 80, rows: 24, shell: "/bin/sh" } });
    expect(created.ok).toBe(true);
    const ptyId = String((created["reply"] as Record<string, unknown>)["ptyId"]);
    await c.request("daemon.send", { channel: first, frame: { op: "pty.attach", ptyId } });
    await c.request("daemon.send", { channel: first, frame: { op: "pty.write", ptyId, data: "echo relay-mark-$((40 + 2))\r" } });
    await until(() => framesOn(c, first, "daemon.event").some(e => (e["event"] as Record<string, unknown>)["type"] === "pty.data" && String((e["event"] as Record<string, unknown>)["data"]).includes("relay-mark-42")), 10_000);
    // The second channel never attached, so the daemon pushed it nothing but its own hello.
    expect(framesOn(c, second, "daemon.event").map(e => (e["event"] as Record<string, unknown>)["type"])).toEqual(["daemon.hello"]);

    // The host carried the refusal rather than raising one of its own: ok at this level, the daemon's answer inside.
    const refused = await c.request("daemon.send", { channel: first, frame: { op: "fs.list", path: 7 } });
    expect(refused.ok).toBe(true);
    // The sentence is the daemon's own; what this pins is that the host carried one with its code.
    const reply = refused["reply"] as Record<string, unknown>;
    expect(reply).toMatchObject({ ok: false, code: "bad-request" });
    expect(typeof reply["error"]).toBe("string");
    expect(reply["error"]).not.toBe("");
    c.close();
  }, 20_000);

  it("a channel is never reachable from another socket, whatever id it guesses", async () => {
    daemon = await startTestDaemon();
    const { workspaceId } = await served(`ws://127.0.0.1:${daemon.port}`);
    const owner = await client();
    const other = await client();
    const channel = String((await owner.request("daemon.open", { workspaceId }))["channel"]);

    const stolen = await other.request("daemon.send", { channel, frame: { op: "ping" } });
    expect(stolen).toMatchObject({ ok: false });
    expect(stolen["kind"]).toBeUndefined();
    expect(await owner.request("daemon.send", { channel, frame: { op: "ping" } })).toMatchObject({ ok: true, reply: { ok: true } });
    expect(await other.request("daemon.close", { channel })).toMatchObject({ ok: false });
    owner.close();
    other.close();
  }, 15_000);

  it("a socket that goes takes every channel it opened with it", async () => {
    daemon = await startTestDaemon();
    proxy = await startTcpProxy(daemon.port);
    const { workspaceId } = await served(`ws://127.0.0.1:${proxy.port}`);
    const c = await client();
    await c.request("daemon.open", { workspaceId });
    await c.request("daemon.open", { workspaceId });
    expect(proxy.live()).toBe(2);
    c.close();
    await until(() => proxy!.live() === 0);
  }, 15_000);

  it("a daemon socket that ends under a channel says so once; a close the page asked for says nothing", async () => {
    daemon = await startTestDaemon();
    proxy = await startTcpProxy(daemon.port);
    const { workspaceId } = await served(`ws://127.0.0.1:${proxy.port}`);
    const c = await client();
    const cut = String((await c.request("daemon.open", { workspaceId }))["channel"]);
    const asked = String((await c.request("daemon.open", { workspaceId }))["channel"]);
    expect(await c.request("daemon.close", { channel: asked })).toMatchObject({ ok: true });

    proxy.cutAll();
    await until(() => framesOn(c, cut, "daemon.closed").length > 0);
    expect(framesOn(c, cut, "daemon.closed")[0]).toMatchObject({ code: expect.any(Number), reason: expect.any(String) });
    // The page asked for that one, so nothing is pushed about it, then or later.
    expect(framesOn(c, asked, "daemon.closed")).toEqual([]);
    // A frame down a channel whose daemon socket ended is answered, not left hanging.
    expect(await c.request("daemon.send", { channel: cut, frame: { op: "ping" } })).toMatchObject({ ok: false });
    c.close();
  }, 15_000);
});

describe("daemon.open refusals name what shut the door", () => {
  it("a machine with no daemon yet is refused plainly, with no kind for the page to hold", async () => {
    const { workspaceId } = await served("ws://127.0.0.1:1", { execImpl: noDaemonGuest });
    const c = await client();
    const refused = await c.request("daemon.open", { workspaceId });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/no daemon/) });
    expect(refused["kind"]).toBeUndefined();
    c.close();
  });

  it("a daemon that refuses this host's token comes back kind reauth", async () => {
    daemon = await startTestDaemon("another-token");
    const { workspaceId } = await served(`ws://127.0.0.1:${daemon.port}`);
    const c = await client();
    const refused = await c.request("daemon.open", { workspaceId });
    expect(refused).toMatchObject({ ok: false, kind: "reauth" });
    expect(String(refused["error"])).toContain("4401");
    c.close();
  }, 15_000);

  it("a door that answers the upgrade with a status comes back kind refused, carrying the status and its sentence", async () => {
    door = await startRefusingDoor();
    const { workspaceId } = await served(`http://127.0.0.1:${door.port}/`);
    const c = await client();
    const refused = await c.request("daemon.open", { workspaceId });
    expect(refused).toMatchObject({ ok: false, kind: "refused" });
    expect(String(refused["error"])).toContain("403");
    expect(String(refused["error"])).toContain("cross-origin websocket denied");
    c.close();
  });

  it("an unknown workspace is refused before anything is dialled", async () => {
    const { workspaceId } = await served("ws://127.0.0.1:1");
    expect(workspaceId).not.toBe("");
    const c = await client();
    expect(await c.request("daemon.open", { workspaceId: "ws_nobody" })).toMatchObject({ ok: false, error: expect.stringMatching(/no such workspace/) });
    c.close();
  });
});

/** This computer's own wiring, its daemon the one under test. */
function localOn(port: number): LocalWiring {
  localRoot = mkdtempSync(join(tmpdir(), "wsp-serve-local-"));
  const road = { url: `ws://127.0.0.1:${port}`, expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: MACHINE_TOKEN };
  return {
    backend: new LocalBackend({ root: localRoot }),
    execStream: o => localExecStream({ root: localRoot!, runDir: join(localRoot!, "runs"), ...o }),
    home: () => join(localRoot!, ".claude"),
    homeDir: localRoot,
    rootsPath: join(localRoot, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier: copyingFake(),
    daemonRoad: async () => road,
  };
}

describe("who may open a channel", () => {
  it("a relayed socket opens a channel only for a workspace it may drive", async () => {
    daemon = await startTestDaemon();
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN, local: localOn(daemon.port) });
    srv = await serveRuntime(rt, { port: 0, authToken: HOST_TOKEN });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "this computer" });

    const here = await client();
    expect(await here.request("daemon.open", { workspaceId: ws.id })).toMatchObject({ ok: true, channel: expect.any(String) });

    // A machine's road into this host drives no workspace of this computer's own, and the channel is one more verb.
    const ticket = String((await here.request("ticket.issue", { purpose: "relay" }))["ticket"]);
    const relayed = await WsClient.connect(srv.port, { ticket });
    expect(await relayed.request("daemon.open", { workspaceId: ws.id })).toMatchObject({ ok: false, error: relayedRefusal("this computer") });

    here.close();
    relayed.close();
  }, 15_000);
});

describe("a channel to this computer's own daemon", () => {
  it("opens by the place this computer is, with no workspace, and a shell there starts in the home folder", async () => {
    daemon = await startTestDaemon();
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN, local: localOn(daemon.port) });
    srv = await serveRuntime(rt, { port: 0, authToken: HOST_TOKEN });
    const c = await client();
    const opened = await c.request("daemon.open", { placeId: HERE_PLACE_ID });
    expect(opened, String(opened["error"])).toMatchObject({ ok: true, channel: expect.any(String) });
    const channel = String(opened["channel"]);
    await until(() => framesOn(c, channel, "daemon.event").length > 0);
    expect(framesOn(c, channel, "daemon.event")[0]!["event"]).toMatchObject({ type: "daemon.hello" });

    // No cwd named: the pty is the computer's own and opens where its user's home is.
    const created = await c.request("daemon.send", { channel, frame: { op: "pty.create", cols: 200, rows: 24, shell: "/bin/sh" } });
    expect(created["reply"]).toMatchObject({ ok: true });
    const ptyId = String((created["reply"] as Record<string, unknown>)["ptyId"]);
    await c.request("daemon.send", { channel, frame: { op: "pty.attach", ptyId } });
    await c.request("daemon.send", { channel, frame: { op: "pty.write", ptyId, data: "echo at-$(pwd)-mark\r" } });
    const home = process.env["HOME"] ?? homedir();
    const printed = (): string =>
      framesOn(c, channel, "daemon.event")
        .map(e => e["event"] as Record<string, unknown>)
        .filter(e => e["type"] === "pty.data")
        .map(e => String(e["data"]))
        .join("");
    await until(() => printed().includes(`at-${home}-mark`), 10_000);
    c.close();
  }, 20_000);

  it("is the host's own road: a socket let in on a ticket is refused", async () => {
    daemon = await startTestDaemon();
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN, local: localOn(daemon.port) });
    srv = await serveRuntime(rt, { port: 0, authToken: HOST_TOKEN });
    const host = await client();
    const ticket = String((await host.request("ticket.issue", { purpose: "connect" }))["ticket"]);
    const ticketed = await WsClient.connect(srv.port, { ticket });
    expect(await ticketed.request("daemon.open", { placeId: HERE_PLACE_ID })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    host.close();
    ticketed.close();
  }, 15_000);

  it("a host wired with no daemon here says so in one sentence", async () => {
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN });
    srv = await serveRuntime(rt, { port: 0, authToken: HOST_TOKEN });
    const c = await client();
    expect(await c.request("daemon.open", { placeId: HERE_PLACE_ID })).toMatchObject({ ok: false, error: expect.stringMatching(/no daemon/) });
    c.close();
  }, 15_000);
});
