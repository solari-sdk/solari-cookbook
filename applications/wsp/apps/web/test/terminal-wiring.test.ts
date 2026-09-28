// SPDX-License-Identifier: AGPL-3.0-only
// Production wiring: every running workspace in the store gets a
// WorkspaceTerminals in the registry, linked through the host's relay.
import { homedir } from "node:os";
import { startOldDaemon, type OldDaemon } from "../../../packages/daemon/test/old-daemon.js";
import { DAEMON_VERSION, type DaemonLinkStatus, type WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { getDaemonRoot, getDaemonVersion } from "../src/files/wire.js";
import { getLive, resetLive } from "../src/machine/live.js";
import { getProcs, resetProcs } from "../src/machine/procs.js";
import { terminalEmptyLine, terminalPaneState, terminalPaneTitle } from "../src/adapt/index.js";
import { getTerminals } from "../src/terminal/link.js";
import { wireTerminals } from "../src/terminal/wiring.js";
import { caps } from "./caps.js";
import { harnessMachineToken, startRelayHarness, type RelayHarness } from "./relay-harness.js";
import { clearNotices } from "./notice-text.js";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 25));
  }
}

const view = (id: string, phase: "running" | "napping" = "running"): WorkspaceView => ({
  id,
  name: id,
  machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase,
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

function fakeApi(workspaces: WorkspaceView[], relay: () => RelayHarness) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const touches: string[] = [];
  const api: Api = {
    touch: async id => {
      touches.push(id);
    },
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => (caps()),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    listSessions: async () => [],
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    // Every workspace here rides one host's relay; the harness's own workspace id is what its daemon answers for.
    daemon: {
      open: async () => relay().api.daemon.open({ workspaceId: relay().workspaceId }),
      send: (channel, frame) => relay().api.daemon.send(channel, frame),
      close: channel => relay().api.daemon.close(channel),
      onFrame: (channel, fn) => relay().api.daemon.onFrame(channel, fn),
    },
    getGolden: async () => undefined,
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const emit = (e: ProtocolEvent) => {
    for (const fn of [...listeners]) fn(e);
  };
  return { api, emit, touches };
}

let relay: RelayHarness | undefined;
let oldDaemon: OldDaemon | undefined;
let unwire: (() => void) | undefined;

beforeEach(async () => {
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, sessions: {}, ready: false, conn: "live" });
  clearNotices();
  resetLive();
  resetProcs();
  relay = await startRelayHarness({
    procs: [{ pid: 1, comm: "init" }, { pid: 2, ppid: 1, comm: "node" }],
    sys: { load1: 0.1, memTotalKb: 8_000, memAvailableKb: 6_000 },
    daemonArgs: { sysIntervalMs: 20, procIntervalMs: 20 },
  });
});
afterEach(async () => {
  unwire?.();
  unwire = undefined;
  await relay?.close();
  relay = undefined;
  await oldDaemon?.close();
  oldDaemon = undefined;
});

describe("wireTerminals", () => {
  it("links every running workspace, parks napping ones, and forgets deleted ones", async () => {
    const { api, emit } = fakeApi([view("ws_run"), view("ws_nap", "napping")], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);

    await until(() => getTerminals("ws_run")?.status() === "live");
    expect(getDaemonRoot("ws_run")).toBe(process.env["HOME"] ?? homedir());
    // The live link asked for sys.watch: samples land in the workspace's live store, none for the napping one.
    await until(() => getLive("ws_run").snapshot().samples.length > 0);
    expect(getLive("ws_run").snapshot().reach).toBe("live");
    // The numbers are the fake machine's own: its loadavg and its meminfo, in the bytes the daemon reports.
    expect(getLive("ws_run").snapshot().samples[0]).toMatchObject({ type: "sys.sample", load1: 0.1, mem: { used: 2_000 * 1024, total: 8_000 * 1024 } });
    expect(getLive("ws_nap").snapshot()).toEqual({ samples: [], reach: "unreachable", unavailable: null });
    // Processes stream only while a pane holds a watch; the hold outlives the socket and asks again when it is back.
    expect(getProcs("ws_run").snapshot()).toEqual({ snapshot: null, reach: "live", unavailable: null });
    const release = getProcs("ws_run").watch();
    await until(() => getProcs("ws_run").snapshot().snapshot !== null);
    expect(getProcs("ws_run").snapshot().snapshot!.procs.map(p => p.pid)).toEqual([1, 2]);
    expect(getDaemonRoot("ws_nap")).toBeNull();
    const napping = getTerminals("ws_nap");
    expect(napping).not.toBeNull();
    expect(napping!.status()).toBe("opening");

    const tab = await getTerminals("ws_run")!.open({ shell: "/bin/sh" });
    expect((await relay!.ptys()).map(p => p.id)).toEqual([tab.ptyId]);

    // napped: the socket goes away, the model (and its tabs) stays for the wake, so it keeps the word of a link
    // that was up and is coming back rather than one nothing has ever been open on.
    emit({ type: "workspace.napped", workspaceId: "ws_run" });
    await until(() => getTerminals("ws_run")!.status() === "connecting");
    expect(getTerminals("ws_run")!.tabs()).toHaveLength(1);
    expect(getLive("ws_run").snapshot().reach).toBe("unreachable");
    expect(getLive("ws_run").snapshot().samples.length).toBeGreaterThan(0);
    expect(getProcs("ws_run").snapshot().reach).toBe("unreachable");

    emit({ type: "workspace.woken", workspaceId: "ws_run", machineId: "m_ws_run", resurrected: false });
    await until(() => getTerminals("ws_run")!.status() === "live");
    // The new socket was asked to watch again: a sample newer than the last one before the nap arrives.
    const beforeWake = getLive("ws_run").snapshot().samples.length;
    await until(() => getLive("ws_run").snapshot().samples.length > beforeWake);
    const procsBeforeWake = getProcs("ws_run").snapshot().snapshot!.at;
    await until(() => getProcs("ws_run").snapshot().snapshot!.at > procsBeforeWake);
    release();

    emit({ type: "workspace.deleted", workspaceId: "ws_run" });
    await until(() => getTerminals("ws_run") === null);
    expect(getDaemonRoot("ws_run")).toBeNull();
  }, 15_000);

  it("typing into a terminal touches the workspace once per throttle window, not per keystroke", async () => {
    const { api, touches } = fakeApi([view("ws_a")], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30, touchMinMs: 200 });
    useStore.getState().bind(api);
    await until(() => getTerminals("ws_a")?.status() === "live");
    const tab = await getTerminals("ws_a")!.open({ shell: "/bin/sh" });
    expect(touches).toEqual([]); // opening a terminal is not a person acting in it
    for (const ch of "echo hi") getTerminals("ws_a")!.write(tab.ptyId, ch);
    await until(() => touches.length === 1);
    await new Promise(r => setTimeout(r, 250));
    getTerminals("ws_a")!.write(tab.ptyId, "\n");
    await until(() => touches.length === 2);
    expect(touches).toEqual(["ws_a", "ws_a"]);
  }, 15_000);

  it("a workspace created after wiring gets its link too", async () => {
    const workspaces = [view("ws_a")];
    const { api, emit } = fakeApi(workspaces, () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => getTerminals("ws_a")?.status() === "live");
    emit({ type: "workspace.created", workspace: view("ws_b") });
    await until(() => getTerminals("ws_b")?.status() === "live");
  }, 15_000);

  it("asks no daemon for the readings of the workspace that is this computer, and puts no link's health on its rows", async () => {
    const { api } = fakeApi([{ ...view("ws_here"), kind: "local" }, view("ws_fork")], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);

    await until(() => getTerminals("ws_here")?.status() === "live" && getTerminals("ws_fork")?.status() === "live");
    // The fork reads its own machine and pushes over its link; this computer is read in the host, so asking its
    // daemon for the same stream would set a second sampler going on the one machine both would be reading.
    await until(() => getLive("ws_fork").snapshot().samples.length > 1);
    expect(getLive("ws_here").snapshot()).toEqual({ samples: [], reach: "unreachable", unavailable: null });
  }, 15_000);

  it("a daemon from before the version says so in its hello, its refusals read unavailable instead of pending, and a redeployed daemon fills the rows", async () => {
    oldDaemon = await startOldDaemon(harnessMachineToken("m1"));
    relay!.setRoad(`ws://127.0.0.1:${oldDaemon.port}`);
    const { api } = fakeApi([view("ws_a")], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => getTerminals("ws_a")?.status() === "live");
    expect(getDaemonRoot("ws_a")).toBe("/root");
    // A hello without a version is the first one; the app knows what it lacks from that alone.
    expect(getDaemonVersion("ws_a")).toBe(1);
    // The daemon answered sys.watch with an error and the app kept it: the rows read unavailable, never pending.
    await until(() => getLive("ws_a").snapshot().unavailable !== null);
    expect(getLive("ws_a").snapshot()).toEqual({ samples: [], reach: "live", unavailable: "unknown op: sys.watch" });
    expect(oldDaemon.ops.filter(op => op === "sys.watch")).toEqual(["sys.watch"]);

    // The update: the old daemon goes down and the current one answers the next dial on the same road.
    relay!.setRoad(`ws://127.0.0.1:${relay!.daemon.port}`);
    await oldDaemon.close();
    oldDaemon = undefined;
    await until(() => getDaemonVersion("ws_a") === DAEMON_VERSION);
    await until(() => getLive("ws_a").snapshot().samples.length > 0);
    expect(getLive("ws_a").snapshot().unavailable).toBeNull();
  }, 15_000);

  it("a host socket that leaves live parks every link, and relinks them when it is back", async () => {
    const { api } = fakeApi([view("ws_a")], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => getTerminals("ws_a")?.status() === "live");
    const tab = await getTerminals("ws_a")!.open({ shell: "/bin/sh" });

    // Every word the model reports from here on, so the relink cannot slip a "starting" through between two beats.
    const words: DaemonLinkStatus[] = [];
    const unwatch = getTerminals("ws_a")!.onStatus(() => words.push(getTerminals("ws_a")!.status()));

    // Every channel rides the host's socket, so a host that is redialling is a pane with nothing to type into.
    useStore.getState().setConn("reconnecting");
    await until(() => getTerminals("ws_a")!.status() === "connecting");
    expect(getLive("ws_a").snapshot().reach).toBe("unreachable");
    expect(getProcs("ws_a").snapshot().reach).toBe("unreachable");
    // The model is kept across the park, as it is across a nap: the tab and its scrollback are still there.
    expect(getTerminals("ws_a")!.tabs().map(t => t.ptyId)).toEqual([tab.ptyId]);
    // And the person reads the word for that: a terminal they had open is coming back, not one being started. The
    // link object behind it is gone and the next one is fresh, which is not what happened from where they sit.
    const parked = terminalPaneState({ state: "running", reach: "reachable", socket: getTerminals("ws_a")!.status() });
    expect(parked).toEqual({ kind: "reconnecting" });
    expect(terminalPaneTitle(parked)).toMatch(/^Reconnecting to /);
    expect(terminalEmptyLine(parked)).not.toMatch(/Starting a terminal/);
    // The link the redial opens is a fresh object, and a second park still reads the same: what the model has been
    // outlives every link it has held.
    useStore.getState().setConn("live");
    await until(() => getTerminals("ws_a")!.status() === "live");
    useStore.getState().setConn("reconnecting");
    await until(() => getTerminals("ws_a")!.status() === "connecting");

    useStore.getState().setConn("live");
    await until(() => getTerminals("ws_a")!.status() === "live");
    expect(getLive("ws_a").snapshot().reach).toBe("live");
    // Not once across two parks and two relinks: the link the redial opens is a fresh object, and it takes the word
    // from the model rather than from its own age.
    unwatch();
    expect(words).not.toContain("opening");
    expect(new Set(words)).toEqual(new Set(["connecting", "live"]));
  }, 20_000);

  it("unwiring closes every link and empties the registry", async () => {
    const { api } = fakeApi([view("ws_a")], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => getTerminals("ws_a")?.status() === "live");
    unwire();
    unwire = undefined;
    expect(getTerminals("ws_a")).toBeNull();
  }, 15_000);
});
