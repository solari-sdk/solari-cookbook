// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonEvent, DaemonLinkStatus } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { fakeProcTree, setListeners } from "../../daemon/test/fake-proc.js";
import { daemonUnderTest, type DaemonUnderTest } from "../../daemon/test/harness.js";
import { connectDaemon, daemonWsUrl, type DaemonReach } from "../src/reach.js";
import { startTcpProxy, type TcpProxy } from "./tcp-proxy.js";
import { until } from "./until.js";

const TOKEN = "reach-token";

let daemon: DaemonUnderTest | undefined;
let proxy: TcpProxy | undefined;
let reach: DaemonReach | undefined;
let inboxDir: string | undefined;
let procRoot: string | undefined;

// The machine the daemon reads is a fake /proc tree and a folder of this test's own: darwin has neither
// /proc/net/tcp nor /root/.wsp/inbox, and a listener here is a row written into that tree.
async function startTestDaemon(): Promise<DaemonUnderTest> {
  inboxDir = mkdtempSync(join(tmpdir(), "wsp-reach-inbox-"));
  procRoot = fakeProcTree([]);
  return daemonUnderTest({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    inbox: inboxDir,
    inboxQuietMs: 100,
    inboxPollMs: 25,
    procRoot,
    portsIntervalMs: 25,
  });
}

afterEach(async () => {
  reach?.close();
  reach = undefined;
  await proxy?.close();
  proxy = undefined;
  await daemon?.close();
  daemon = undefined;
  if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  inboxDir = undefined;
  if (procRoot) rmSync(procRoot, { recursive: true, force: true });
  procRoot = undefined;
});

describe("daemonWsUrl", () => {
  it("turns a previewUrl into a wss url carrying the edge token and never ours", () => {
    const url = daemonWsUrl("https://abc123-7070.preview.getsolari.com/?pt_token=edge");
    expect(url).toBe("wss://abc123-7070.preview.getsolari.com/?pt_token=edge");
    expect(new URL(url).searchParams.has("token")).toBe(false);
  });

  it("keeps ws urls as they are", () => {
    expect(daemonWsUrl("ws://127.0.0.1:7070")).toBe("ws://127.0.0.1:7070/");
  });
});

describe("connectDaemon", () => {
  it("heartbeats at the configured interval and gets acks back", async () => {
    daemon = await startTestDaemon();
    reach = connectDaemon({
      previewUrl: `ws://127.0.0.1:${daemon.port}`,
      token: TOKEN,
      onEvent: () => {},
      heartbeatMs: 100,
    });
    await reach.ready;
    await until(() => reach!.stats().pongsReceived >= 3);
    expect(reach.stats().pingsSent).toBeGreaterThanOrEqual(3);
  });

  it("survives a cut socket: reconnects, re-subscribes, and rescans the inbox", async () => {
    daemon = await startTestDaemon();
    const f1 = join(inboxDir!, "before.bin");
    writeFileSync(f1, "1".repeat(11));
    proxy = await startTcpProxy(daemon.port);

    const events: DaemonEvent[] = [];
    const seen = (path: string) => events.filter(e => e.type === "inbox.file" && e.path === path).length;
    reach = connectDaemon({
      previewUrl: `ws://127.0.0.1:${proxy.port}`,
      token: TOKEN,
      onEvent: e => events.push(e),
      heartbeatMs: 100,
      backoffMs: () => 300, // long enough for a file to settle inside the gap
    });
    await reach.ready;

    // initial rescan announced the pre-existing file
    await until(() => seen(f1) >= 1);

    // the sweep: connection dies, and a file lands AND settles while nobody is
    // subscribed, so its push event goes to no one
    proxy.cutAll();
    const f2 = join(inboxDir!, "during-gap.bin");
    writeFileSync(f2, "2".repeat(22));

    // only a post-reconnect rescan can re-announce the long-settled f1
    await until(() => seen(f1) >= 2);
    // and the file lost in the gap was recovered
    await until(() => seen(f2) >= 1);
    // the rescan pushes its files before it replies, and the ritual counts the reconnect after the reply
    await until(() => reach!.stats().reconnects >= 1);

    // ports.watch was re-subscribed on the new connection
    setListeners(procRoot!, [{ port: 9999, pid: 42 }]);
    await until(() => events.some(e => e.type === "port.open" && e.port === 9999));

    // inbox.watch was re-subscribed too: a post-reconnect file still arrives
    const f3 = join(inboxDir!, "after.bin");
    writeFileSync(f3, "3".repeat(33));
    await until(() => events.some(e => e.type === "inbox.file" && e.path === f3));

    // heartbeats keep flowing on the new socket
    const pongs = reach.stats().pongsReceived;
    await until(() => reach!.stats().pongsReceived > pongs);
  });

  it("reports connecting then live on first connect", async () => {
    daemon = await startTestDaemon();
    const statuses: DaemonLinkStatus[] = [];
    reach = connectDaemon({
      previewUrl: `ws://127.0.0.1:${daemon.port}`,
      token: TOKEN,
      onEvent: () => {},
      onStatus: s => statuses.push(s),
    });
    await reach.ready;
    expect(statuses).toEqual(["connecting", "live"]);
    expect(reach.status()).toBe("live");
  });

  it("cycles connecting → live across a cut socket, without duplicate emissions", async () => {
    daemon = await startTestDaemon();
    proxy = await startTcpProxy(daemon.port);
    const statuses: DaemonLinkStatus[] = [];
    reach = connectDaemon({
      previewUrl: `ws://127.0.0.1:${proxy.port}`,
      token: TOKEN,
      onEvent: () => {},
      heartbeatMs: 100,
      backoffMs: () => 25,
      onStatus: s => statuses.push(s),
    });
    await reach.ready;
    proxy.cutAll();
    await until(() => statuses.filter(s => s === "live").length >= 2);
    expect(statuses).toEqual(["connecting", "live", "connecting", "live"]);
  });

  it("rejects ready and reports reauth-needed on a bad token", async () => {
    daemon = await startTestDaemon();
    const statuses: DaemonLinkStatus[] = [];
    reach = connectDaemon({
      previewUrl: `ws://127.0.0.1:${daemon.port}`,
      token: "wrong-token",
      onEvent: () => {},
      onStatus: s => statuses.push(s),
    });
    await expect(reach.ready).rejects.toThrow("4401");
    expect(statuses).toEqual(["connecting", "reauth-needed"]);
  });

  it("surfaces a post-establishment 4401 as reauth-needed and stops retrying", async () => {
    daemon = await startTestDaemon();
    proxy = await startTcpProxy(daemon.port);
    const statuses: DaemonLinkStatus[] = [];
    reach = connectDaemon({
      previewUrl: `ws://127.0.0.1:${proxy.port}`,
      token: TOKEN,
      onEvent: () => {},
      heartbeatMs: 100,
      backoffMs: () => 25,
      onStatus: s => statuses.push(s),
    });
    await reach.ready;

    // The token stops being honored mid-session: every redial now gets a 4401.
    const port = proxy.port;
    await proxy.close();
    proxy = undefined;
    const rejecting = new WebSocketServer({ host: "127.0.0.1", port });
    let dials = 0;
    rejecting.on("connection", ws => {
      dials++;
      ws.close(4401, "unauthorized");
    });
    try {
      await until(() => statuses.includes("reauth-needed"));
      expect(statuses).toEqual(["connecting", "live", "connecting", "reauth-needed"]);
      const seen = dials;
      await new Promise(r => setTimeout(r, 200)); // several backoff periods
      expect(dials).toBe(seen); // reauth is terminal: retrying cannot fix a bad token
      expect(reach.status()).toBe("reauth-needed");
    } finally {
      await new Promise<void>(resolve => rejecting.close(() => resolve()));
    }
  });

  it("reports dead once the client closes", async () => {
    daemon = await startTestDaemon();
    const statuses: DaemonLinkStatus[] = [];
    reach = connectDaemon({
      previewUrl: `ws://127.0.0.1:${daemon.port}`,
      token: TOKEN,
      onEvent: () => {},
      onStatus: s => statuses.push(s),
    });
    await reach.ready;
    reach.close();
    reach = undefined;
    expect(statuses).toEqual(["connecting", "live", "dead"]);
  });

  it("keeps retrying while the daemon is unreachable and connects once it is back", async () => {
    daemon = await startTestDaemon();
    const dead = await startTcpProxy(daemon.port);
    const port = dead.port;
    await dead.close(); // nothing listens on `port` now

    reach = connectDaemon({
      previewUrl: `ws://127.0.0.1:${port}`,
      token: TOKEN,
      onEvent: () => {},
      heartbeatMs: 100,
      backoffMs: () => 25,
    });
    await new Promise(r => setTimeout(r, 150)); // let a few dials fail
    proxy = await startTcpProxy(daemon.port, port); // daemon reachable again on the same port
    await reach.ready;
    await until(() => reach!.stats().pongsReceived >= 1);
  });

  it("takes a socket somebody else opened without an auth frame of its own, and is dead when that socket goes", async () => {
    // The link a place dials out on: its handshake was the auth, so the ritual on it starts at the watches. Nothing
    // here redials, since only that computer can open one.
    daemon = await startTestDaemon();
    const WebSocketClient = (await import("ws")).default;
    const ws = new WebSocketClient(`ws://127.0.0.1:${daemon.port}/`);
    await new Promise<void>((done, fail) => {
      ws.once("open", () => done());
      ws.once("error", fail);
    });
    // The daemon's inbound door wants an auth frame first, so this socket is authed the way an inbound one is and
    // then handed over: what this proves is that connectDaemon sends none of its own.
    ws.send(JSON.stringify({ id: 0, op: "auth", token: TOKEN }));
    await new Promise(r => setTimeout(r, 50));
    const states: DaemonLinkStatus[] = [];
    reach = connectDaemon({ socket: ws, onEvent: () => {}, onStatus: s => states.push(s), heartbeatMs: 50 });
    await reach.ready;
    expect(states).toContain("live");
    await until(() => reach!.stats().pongsReceived >= 1);
    // A second auth frame would have been refused by the daemon and cut the socket; the link stood.
    expect(reach.stats().reconnects).toBe(0);
    ws.close();
    await until(() => reach!.status() === "dead");
  });

  it("refuses to be built with neither a route to dial nor a socket to take", () => {
    expect(() => connectDaemon({ onEvent: () => {} })).toThrow(/previewUrl to dial or an open socket/);
    expect(() => connectDaemon({ previewUrl: "ws://127.0.0.1:1", onEvent: () => {} })).toThrow(/needs the daemon's token/);
  });
});
