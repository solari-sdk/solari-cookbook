// SPDX-License-Identifier: AGPL-3.0-only
// One dial of one daemon for one client, against a real daemon binary and
// against a door that answers the upgrade with a status instead of 101.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootsPathIn } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProcTree } from "../../daemon/test/fake-proc.js";
import { daemonUnderTest, type DaemonUnderTest } from "../../daemon/test/harness.js";
import { DaemonDoorError, DaemonTokenError, openDaemonChannel, type DaemonChannel } from "../src/daemon-channel.js";
import { startRefusingDoor, type RefusingDoor } from "./refusing-door.js";
import { startTcpProxy, type TcpProxy } from "./tcp-proxy.js";
import { until } from "./until.js";

const TOKEN = "channel-token";

let daemon: DaemonUnderTest | undefined;
let channel: DaemonChannel | undefined;
let proxy: TcpProxy | undefined;
let door: RefusingDoor | undefined;
let inboxDir: string | undefined;
let procRoot: string | undefined;

async function startTestDaemon(): Promise<DaemonUnderTest> {
  inboxDir = mkdtempSync(join(tmpdir(), "wsp-channel-inbox-"));
  procRoot = fakeProcTree([]);
  return daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, inbox: inboxDir, rootsPath: rootsPathIn(inboxDir), procRoot, portsIntervalMs: 1000 });
}

afterEach(async () => {
  channel?.close();
  channel = undefined;
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
});

describe("openDaemonChannel", () => {
  it("dials once, authenticates, and round-trips the daemon's own replies with the hello as the first event", async () => {
    daemon = await startTestDaemon();
    const events: Record<string, unknown>[] = [];
    channel = await openDaemonChannel({ url: `ws://127.0.0.1:${daemon.port}`, token: TOKEN, onEvent: e => events.push(e) });
    await until(() => events.length > 0);
    expect(events[0]).toMatchObject({ type: "daemon.hello" });

    const created = (await channel.send({ op: "pty.create", cols: 80, rows: 24, shell: "/bin/sh" })) as Record<string, unknown>;
    expect(created["ok"]).toBe(true);
    const ptyId = String(created["ptyId"]);
    expect((await channel.send({ op: "pty.attach", ptyId }))["ok"]).toBe(true);
    expect((await channel.send({ op: "pty.write", ptyId, data: "echo channel-mark-$((40 + 2))\r" }))["ok"]).toBe(true);
    await until(() => events.some(e => e["type"] === "pty.data" && String(e["data"]).includes("channel-mark-42")), 10_000);
  }, 15_000);

  it("hands a refusal back as the daemon wrote it, with the typed code and no throw", async () => {
    daemon = await startTestDaemon();
    channel = await openDaemonChannel({ url: `ws://127.0.0.1:${daemon.port}`, token: TOKEN, onEvent: () => {} });
    // The sentence is the daemon's own; what this pins is that one arrives with its code rather than as a throw.
    const refused = await channel.send({ op: "fs.list", path: 7 });
    expect(refused).toMatchObject({ ok: false, code: "bad-request" });
    expect(typeof refused["error"]).toBe("string");
    expect(refused["error"]).not.toBe("");
  });

  it("a token the daemon refuses rejects as a token error carrying its 4401 sentence", async () => {
    daemon = await startTestDaemon();
    const failed = await openDaemonChannel({ url: `ws://127.0.0.1:${daemon.port}`, token: "stale", onEvent: () => {} }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(DaemonTokenError);
    expect((failed as DaemonTokenError).kind).toBe("reauth");
    expect((failed as DaemonTokenError).message).toContain("4401");
  });

  it("a door that answers the upgrade with a status rejects as a door error carrying the status and the body's first line", async () => {
    door = await startRefusingDoor(403, "cross-origin websocket denied\nthe edge said so");
    const failed = await openDaemonChannel({ url: `http://127.0.0.1:${door.port}/`, token: TOKEN, onEvent: () => {} }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(DaemonDoorError);
    expect((failed as DaemonDoorError).kind).toBe("refused");
    expect((failed as DaemonDoorError).status).toBe(403);
    expect((failed as DaemonDoorError).message).toContain("403");
    expect((failed as DaemonDoorError).message).toContain("cross-origin websocket denied");
    // One line of the body, so a door that answers an HTML page does not become the pane's sentence.
    expect((failed as DaemonDoorError).message).not.toContain("the edge said so");
  });

  it("a port nothing listens on and a door that never answers both reject plainly, with no kind to read", async () => {
    daemon = await startTestDaemon();
    const dead = daemon.port;
    await daemon.close();
    daemon = undefined;
    const refused = await openDaemonChannel({ url: `ws://127.0.0.1:${dead}`, token: TOKEN, onEvent: () => {} }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as { kind?: unknown }).kind).toBeUndefined();
    expect(refused).not.toBeInstanceOf(DaemonDoorError);

    daemon = await startTestDaemon();
    proxy = await startTcpProxy(daemon.port);
    proxy.stall();
    const timedOut = await openDaemonChannel({ url: `ws://127.0.0.1:${proxy.port}`, token: TOKEN, onEvent: () => {}, connectTimeoutMs: 150 }).catch((e: unknown) => e);
    expect(timedOut).toBeInstanceOf(Error);
    expect((timedOut as Error).message).toContain("timed out");
    expect((timedOut as { kind?: unknown }).kind).toBeUndefined();
  }, 15_000);

  it("closed settles once with the code and reason, and a send in flight when the socket goes rejects", async () => {
    daemon = await startTestDaemon();
    proxy = await startTcpProxy(daemon.port);
    const ch = await openDaemonChannel({ url: `ws://127.0.0.1:${proxy.port}`, token: TOKEN, onEvent: () => {} });
    channel = ch;
    proxy.stall();
    const inFlight = ch.send({ op: "ping" }).catch((e: unknown) => e);
    proxy.cutAll();
    expect(await inFlight).toEqual(new Error("connection lost"));
    const ended = await ch.closed;
    expect(ended).toMatchObject({ code: expect.any(Number), reason: expect.any(String) });
    expect(await ch.closed).toBe(ended);
    // A dead channel answers a send rather than hanging on it.
    await expect(ch.send({ op: "ping" })).rejects.toThrow();
  }, 15_000);

  it("a close the caller asked for settles closed too, so the socket per channel is never left behind", async () => {
    daemon = await startTestDaemon();
    const ch = await openDaemonChannel({ url: `ws://127.0.0.1:${daemon.port}`, token: TOKEN, onEvent: () => {} });
    channel = ch;
    ch.close();
    expect(await ch.closed).toMatchObject({ code: expect.any(Number) });
  });
});
