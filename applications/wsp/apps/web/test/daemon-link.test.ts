// SPDX-License-Identifier: AGPL-3.0-only
// The browser's daemon link over the host's relay: a real daemon, a real
// runtime and the page's own client between them, so a link that goes live
// drove a pty through two sockets. The tcp proxy from the runtime test suite
// stands in for the road a cut or a stall happens on.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonEvent, DaemonLinkStatus } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { connectDaemonLink, DaemonRequestError, UNWORDED_REFUSAL, type DaemonLink } from "../src/terminal/daemon-link.js";
import { startRefusingDoor, type RefusingDoor } from "../../../packages/runtime/test/refusing-door.js";
import { startTcpProxy, type TcpProxy } from "../../../packages/runtime/test/tcp-proxy.js";
import { harnessMachineToken, startRelayHarness, type RelayHarness } from "./relay-harness.js";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 25));
  }
}

let harness: RelayHarness | undefined;
let proxy: TcpProxy | undefined;
let link: DaemonLink | undefined;
let door: RefusingDoor | undefined;
let tokenDir: string | undefined;

function connect(over: RelayHarness, opts: Partial<Parameters<typeof connectDaemonLink>[0]> = {}, onEvent: (e: DaemonEvent) => void = () => {}): DaemonLink {
  return connectDaemonLink({ daemon: over.api.daemon, target: { workspaceId: over.workspaceId }, onEvent, ...opts });
}

afterEach(async () => {
  link?.close();
  link = undefined;
  await proxy?.close();
  proxy = undefined;
  await door?.close();
  door = undefined;
  await harness?.close();
  harness = undefined;
  if (tokenDir) rmSync(tokenDir, { recursive: true, force: true });
  tokenDir = undefined;
});

describe("connectDaemonLink over the host's relay", () => {
  it("goes live, round-trips pty ops, and delivers pty.data events", async () => {
    harness = await startRelayHarness();
    const events: DaemonEvent[] = [];
    const statuses: DaemonLinkStatus[] = [];
    link = connect(harness, { onStatus: s => statuses.push(s) }, e => events.push(e));
    await until(() => link!.status() === "live");
    expect(statuses).toEqual(["opening", "live"]);
    // The daemon's hello is the first thing on a fresh channel, so the pane knows the root before anything else.
    expect(events[0]).toMatchObject({ type: "daemon.hello" });

    const created = await link.request("pty.create", { cols: 80, rows: 24, shell: "/bin/sh" });
    const ptyId = String(created["ptyId"]);
    await link.request("pty.attach", { ptyId });
    await link.request("pty.write", { ptyId, data: "echo link-mark-$((40 + 2))\r" });
    await until(() => events.some(e => e.type === "pty.data" && e.data.includes("link-mark-42")), 10_000);
  }, 20_000);

  it("a refusal rejects as DaemonRequestError, with the typed code when the op sends one", async () => {
    harness = await startRelayHarness();
    link = connect(harness);
    await until(() => link!.status() === "live");
    const coded = await link.request("fs.list", { path: 7 }).catch((e: unknown) => e);
    expect(coded).toBeInstanceOf(DaemonRequestError);
    expect((coded as DaemonRequestError).code).toBe("bad-request");
    // The sentence is the daemon's own; what this pins is that its own words arrive rather than the stand-in.
    expect((coded as DaemonRequestError).message).not.toBe(UNWORDED_REFUSAL);
    expect((coded as DaemonRequestError).message).not.toBe("");
    const plain = await link.request("pty.write", { ptyId: "nope", data: "x" }).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(DaemonRequestError);
    expect((plain as DaemonRequestError).code).toBeUndefined();
  }, 20_000);

  it("a machine refusing this host's token says reauth-needed, and goes live once the machine takes it", async () => {
    tokenDir = mkdtempSync(join(tmpdir(), "wsp-link-token-"));
    const tokenPath = join(tokenDir, "token");
    writeFileSync(tokenPath, "stale-on-the-machine");
    harness = await startRelayHarness({ tokenPath });
    const statuses: DaemonLinkStatus[] = [];
    link = connect(harness, { onStatus: s => statuses.push(s), backoffMs: () => 40 });
    await until(() => link!.status() === "reauth-needed");
    await expect(link.request("ping")).rejects.toThrow("daemon unreachable");

    writeFileSync(tokenPath, harnessMachineToken("m1"));
    await until(() => link!.status() === "live");
    expect(statuses).toContain("reauth-needed");
    expect(statuses.indexOf("live")).toBeGreaterThan(statuses.indexOf("reauth-needed"));
  }, 20_000);

  it("a door that refuses the upgrade reads refused with the door's own sentence, and holds it across retries", async () => {
    door = await startRefusingDoor();
    harness = await startRelayHarness({ road: () => `http://127.0.0.1:${door!.port}/` });
    const statuses: DaemonLinkStatus[] = [];
    link = connect(harness, { onStatus: s => statuses.push(s), backoffMs: () => 30 });
    await until(() => link!.status() === "refused");
    expect(link.refusal()).toContain("403");
    expect(link.refusal()).toContain("cross-origin websocket denied");
    // A link refused at the door never says reconnecting: it holds the door's sentence while it keeps trying.
    await new Promise(r => setTimeout(r, 200));
    expect(link.status()).toBe("refused");
    expect(statuses).not.toContain("connecting");
    expect(statuses.filter(s => s === "opening")).toHaveLength(1);
    expect(statuses).not.toContain("live");

    // The door opening later needs no reload: the next dial through it goes live.
    harness.setRoad(`ws://127.0.0.1:${harness.daemon.port}`);
    await until(() => link!.status() === "live");
    expect(link.refusal()).toBeNull();
  }, 20_000);

  it("a refusal holds through a dial that fails for a plain reason, since nothing got past the door", async () => {
    door = await startRefusingDoor();
    harness = await startRelayHarness({ road: () => `http://127.0.0.1:${door!.port}/` });
    const statuses: DaemonLinkStatus[] = [];
    link = connect(harness, { onStatus: s => statuses.push(s), backoffMs: () => 30 });
    await until(() => link!.status() === "refused");
    const said = link.refusal();

    // The machine stops answering at all. A page that flipped to reconnecting here would offer a wait that is not
    // coming, and the door's next answer would fire the same sentence again as if it were news.
    await door.close();
    door = undefined;
    await new Promise(r => setTimeout(r, 250));
    expect(link.status()).toBe("refused");
    expect(link.refusal()).toBe(said);
    expect(statuses).not.toContain("live");
    expect(statuses).not.toContain("connecting");
    expect(statuses.filter(s => s === "opening")).toHaveLength(1);
    expect(statuses.filter(s => s === "refused")).toHaveLength(1);

    // Only a dial that gets through ends it.
    harness.setRoad(`ws://127.0.0.1:${harness.daemon.port}`);
    await until(() => link!.status() === "live", 10_000);
    expect(link.refusal()).toBeNull();
  }, 20_000);

  it("a cut daemon socket comes back on a new channel and the reconnect count moves", async () => {
    harness = await startRelayHarness();
    proxy = await startTcpProxy(harness.daemon.port);
    harness.setRoad(`ws://127.0.0.1:${proxy.port}`);
    link = connect(harness, { heartbeatMs: 60, backoffMs: () => 30 });
    await until(() => link!.status() === "live");
    const before = link.stats();
    expect(before.reconnects).toBe(0);

    proxy.cutAll();
    await until(() => link!.stats().reconnects > before.reconnects && link!.status() === "live", 10_000);
    await until(() => link!.stats().pongsReceived > before.pongsReceived, 10_000);
  }, 20_000);

  it("a channel that stops answering heartbeats is abandoned and dialled again", async () => {
    harness = await startRelayHarness();
    proxy = await startTcpProxy(harness.daemon.port);
    harness.setRoad(`ws://127.0.0.1:${proxy.port}`);
    link = connect(harness, { heartbeatMs: 60, backoffMs: () => 30 });
    await until(() => link!.status() === "live");
    const before = link.stats();
    proxy.stall();
    await until(() => link!.status() === "connecting", 5000);
    proxy.resume();
    await until(() => link!.stats().reconnects > before.reconnects && link!.status() === "live", 10_000);
  }, 20_000);

  it("a request made before the channel answered its first ping is refused, not sent", async () => {
    harness = await startRelayHarness();
    link = connect(harness, { backoffMs: () => 30 });
    // The dial is in flight: no channel is proven yet, so the pane's keystroke is refused rather than raced onto it.
    await expect(link.request("ping")).rejects.toThrow("daemon unreachable");
    await until(() => link!.status() === "live");
    expect((await link.request("ping"))["ok"]).toBe(true);
  }, 20_000);

  it("a link the page closed gives the machine its socket back and is terminal", async () => {
    harness = await startRelayHarness();
    proxy = await startTcpProxy(harness.daemon.port);
    harness.setRoad(`ws://127.0.0.1:${proxy.port}`);
    const l = connect(harness, { backoffMs: () => 30 });
    link = l;
    await until(() => l.status() === "live");
    expect(proxy.live()).toBe(1);
    l.close();
    expect(l.status()).toBe("dead");
    await until(() => proxy!.live() === 0);
    await expect(l.request("ping")).rejects.toThrow("daemon unreachable");
  }, 20_000);
});
