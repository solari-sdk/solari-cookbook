// SPDX-License-Identifier: AGPL-3.0-only
// What a workspace's link says about itself, over the host's relay: a real
// daemon, a real runtime and the page's own client between them, so every word
// here was read off a link that really did or did not open. The words come from
// the one state table the pane and the main screen both read.
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { THIS_COMPUTER, type DaemonLinkStatus } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { linkDownLine, terminalEmptyLine, terminalInputRefusal, terminalPaneHints, terminalPaneState, terminalPaneTitle, type TerminalPaneState } from "../src/adapt/index.js";
import { connectDaemonLink, type DaemonLink } from "../src/terminal/daemon-link.js";
import { startRefusingDoor, type RefusingDoor } from "../../../packages/runtime/test/refusing-door.js";
import { startTcpProxy, type TcpProxy } from "../../../packages/runtime/test/tcp-proxy.js";
import { startRelayHarness, type RelayHarness } from "./relay-harness.js";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 25));
  }
}

/** A port this machine just gave up, so a dial at it is refused by the kernel: a road nothing is behind. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

let harness: RelayHarness | undefined;
let proxy: TcpProxy | undefined;
let door: RefusingDoor | undefined;
let link: DaemonLink | undefined;

function connect(over: RelayHarness, opts: Partial<Parameters<typeof connectDaemonLink>[0]> = {}): DaemonLink {
  return connectDaemonLink({ daemon: over.api.daemon, target: { workspaceId: over.workspaceId }, onEvent: () => {}, ...opts });
}

/** The pane as a running workspace draws it from this link, which is what every surface reads. */
function paneOf(l: DaemonLink, local = true): TerminalPaneState {
  return terminalPaneState({ state: "running", reach: "reachable", socket: l.status(), refusal: l.refusal(), local, where: "api" });
}

const saidBy = (pane: TerminalPaneState): string[] => [
  terminalPaneTitle(pane)!,
  terminalEmptyLine(pane)!,
  terminalInputRefusal(pane)!,
  ...terminalPaneHints(pane, null, null),
  linkDownLine(pane) ?? "",
];

/** The word cut: nothing a person reads says machine, on the sentences a link brings as on the ones already here. */
function saysNoMachine(pane: TerminalPaneState): void {
  for (const line of saidBy(pane)) expect(line).not.toMatch(/\bmachines?\b/i);
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
});

describe("the words a link gets", () => {
  it("a link that has never been open says what is being started here, and never that anything is reconnecting", async () => {
    const dead = await deadPort();
    harness = await startRelayHarness({ road: () => `ws://127.0.0.1:${dead}` });
    link = connect(harness, { backoffMs: () => 25, firstAnswerMs: 60_000 });
    // Several dials, every one of them a failure: nothing has been open, so nothing may be promised back.
    await new Promise(r => setTimeout(r, 250));
    expect(link.status()).toBe("opening");

    const pane = paneOf(link);
    expect(pane).toEqual({ kind: "starting", local: true, where: THIS_COMPUTER });
    // The word for the person's own computer is the protocol's, not one typed again here.
    expect(terminalPaneTitle(pane)).toBe(`Starting a terminal on ${THIS_COMPUTER}`);
    expect(terminalEmptyLine(pane)).toBe(`Starting a terminal on ${THIS_COMPUTER}; the first one opens when it is ready`);
    // The one word that promises something back belongs to a link that was open once, and this is not one.
    for (const line of saidBy(pane)) expect(line).not.toMatch(/reconnect/i);
    saysNoMachine(pane);
    // A workspace that is not the person's own computer gets the same shape and is named, so the sentence still
    // says which one when it is read anywhere but inside that workspace's own pane.
    expect(terminalPaneTitle(paneOf(link, false))).toBe("Starting a terminal on api");
    for (const line of saidBy(paneOf(link, false))) expect(line).not.toMatch(/reconnect/i);
    saysNoMachine(paneOf(link, false));
  }, 20_000);

  it("a link that was open and then dropped is the only one that reads reconnecting, and reads it once", async () => {
    harness = await startRelayHarness();
    proxy = await startTcpProxy(harness.daemon.port);
    harness.setRoad(`ws://127.0.0.1:${proxy.port}`);
    const statuses: DaemonLinkStatus[] = [];
    // The redial is put beyond this test, so what the person sees after one drop is one word and not a flicker.
    link = connect(harness, { heartbeatMs: 60, backoffMs: () => 10_000, firstAnswerMs: 60_000, onStatus: s => statuses.push(s) });
    await until(() => link!.status() === "live");
    expect(statuses).toEqual(["opening", "live"]);

    proxy.cutAll();
    await until(() => link!.status() === "connecting");
    const pane = paneOf(link);
    expect(pane).toEqual({ kind: "reconnecting" });
    // The sentence itself is pinned where the state table's own test pins every other one; what this test owns is
    // that a drop is the state that gets it, said once, in words that do not call a workspace a machine.
    expect(terminalPaneTitle(pane)).toMatch(/^Reconnecting to /);
    saysNoMachine(pane);
    expect(statuses.filter(s => s === "connecting")).toHaveLength(1);
  }, 20_000);

  it("a link that never answered says what did not answer and what to do, and a door that answered says it in the door's words", async () => {
    const dead = await deadPort();
    harness = await startRelayHarness({ road: () => `ws://127.0.0.1:${dead}` });
    link = connect(harness, { backoffMs: () => 25, firstAnswerMs: 80 });
    await until(() => link!.status() === "unanswered");

    const pane = paneOf(link);
    expect(pane).toEqual({ kind: "unanswered", local: true, where: THIS_COMPUTER });
    // Two halves: what did not answer, then the one thing a person can do about it.
    expect(terminalPaneTitle(pane)).toBe(`Nothing has answered on ${THIS_COMPUTER}`);
    expect(terminalPaneHints(pane, null, null)).toEqual([`wsp keeps trying; look at the terminal you started wsp in on ${THIS_COMPUTER}`]);
    expect(terminalPaneHints(paneOf(link, false), null, null)).toEqual(["wsp keeps trying; the task's row says what api is doing"]);
    saysNoMachine(paneOf(link, false));
    for (const line of saidBy(pane)) expect(line).not.toMatch(/reconnect/i);
    saysNoMachine(pane);

    // Where the far side answered with a status, its own sentence is what the pane carries instead.
    door = await startRefusingDoor();
    harness.setRoad(`http://127.0.0.1:${door.port}/`);
    await until(() => link!.status() === "refused");
    const refused = paneOf(link);
    expect(refused.kind).toBe("refused");
    expect(terminalEmptyLine(refused)).toContain("403");
    expect(terminalEmptyLine(refused)).toContain("cross-origin websocket denied");
    saysNoMachine(refused);
  }, 20_000);

  it("the main screen carries the link's own line while it is down, and says nothing while it is open", async () => {
    const dead = await deadPort();
    harness = await startRelayHarness({ road: () => `ws://127.0.0.1:${dead}` });
    link = connect(harness, { backoffMs: () => 25, firstAnswerMs: 80 });
    // A first dial inside its bound is not down, so the main screen does not shout on every page load.
    expect(linkDownLine(paneOf(link))).toBeNull();

    await until(() => link!.status() === "unanswered");
    expect(linkDownLine(paneOf(link))).toBe(`Nothing has answered on ${THIS_COMPUTER}`);
    // One place for the words: the main screen says the pane's own sentence, never a second copy of it.
    expect(linkDownLine(paneOf(link))).toBe(terminalPaneTitle(paneOf(link)));

    harness.setRoad(`ws://127.0.0.1:${harness.daemon.port}`);
    await until(() => link!.status() === "live", 10_000);
    expect(linkDownLine(paneOf(link))).toBeNull();
  }, 20_000);
});
