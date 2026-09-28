// SPDX-License-Identifier: AGPL-3.0-only
// The port directory is fed by each workspace's own daemon channel, not the
// runtime stream: one host relays for two workspaces on two daemons of their
// own, so a port on one must never show up on the other.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceView } from "@wsp/protocol";
import { fakeProcTree, setListeners, type FakeListener } from "../../../packages/daemon/test/fake-proc.js";
import { daemonUnderTest, type DaemonUnderTest } from "../../../packages/daemon/test/harness.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBrowser, resetBrowsers } from "../src/browser/model.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
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

const view = (id: string): WorkspaceView => ({
  id,
  name: id,
  machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

function fakeApi(workspaces: WorkspaceView[], relay: () => RelayHarness) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
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
    daemon: {
      open: target => relay().api.daemon.open(target),
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
  return { api, emit };
}

/** A guest's own fake machine: what it has listening is a row written into its tree. */
interface Guest {
  procRoot: string;
}

/** The first guest is the harness's own daemon; every one after it is a daemon of its own on the same host. */
const guests = new Map<string, Guest>();
let relay: RelayHarness | undefined;
let extra: { daemon: DaemonUnderTest; inboxDir: string; procRoot: string }[] = [];
let unwire: (() => void) | undefined;

/** What one guest has listening now; the daemon watching that tree pushes the difference on its next poll. */
const setPorts = (id: string, ports: readonly FakeListener[]): void => setListeners(guests.get(id)!.procRoot, ports);

/** The harness's own workspace, on a daemon whose listening set this test owns. */
async function firstGuest(ports: readonly FakeListener[]): Promise<string> {
  relay = await startRelayHarness({ ports });
  guests.set(relay.workspaceId, { procRoot: relay.procRoot });
  return relay.workspaceId;
}

/** One more workspace on the same host, with a daemon of its own. */
async function nextGuest(ports: readonly FakeListener[]): Promise<string> {
  const inboxDir = mkdtempSync(join(tmpdir(), "wsp-ports-inbox-"));
  const procRoot = fakeProcTree([]);
  setListeners(procRoot, ports);
  const daemon = await daemonUnderTest({ host: "127.0.0.1", port: 0, token: harnessMachineToken("m2"), inbox: inboxDir, procRoot, portsIntervalMs: 50 });
  extra.push({ daemon, inboxDir, procRoot });
  const id = await relay!.addWorkspace("second", `ws://127.0.0.1:${daemon.port}`);
  guests.set(id, { procRoot });
  return id;
}

beforeEach(() => {
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, sessions: {}, ready: false, conn: "live" });
  clearNotices();
});
afterEach(async () => {
  unwire?.();
  unwire = undefined;
  await relay?.close();
  relay = undefined;
  for (const e of extra) {
    await e.daemon.close();
    rmSync(e.inboxDir, { recursive: true, force: true });
    rmSync(e.procRoot, { recursive: true, force: true });
  }
  extra = [];
  guests.clear();
  resetBrowsers();
});

const portsOf = (id: string) => getBrowser(id).ports().map(p => p.port);

describe("port directory over the daemon link", () => {
  it("seeds from the ports.watch reply, follows port.open and port.close, and keeps workspaces apart", async () => {
    const a = await firstGuest([{ port: 3000, pid: 42 }]);
    const b = await nextGuest([{ port: 8080 }]);
    const { api } = fakeApi([view(a), view(b)], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);

    // A tab opened after the server started: the reply carries what is already listening.
    await until(() => portsOf(a).includes(3000));
    expect(getBrowser(a).ports()).toEqual([expect.objectContaining({ port: 3000, pid: 42 })]);
    await until(() => portsOf(b).includes(8080));
    expect(portsOf(b)).toEqual([8080]);

    // The daemon's watcher pushes a new listener without a redial.
    setPorts(a, [{ port: 3000, pid: 42 }, { port: 5173, pid: 7 }]);
    await until(() => portsOf(a).includes(5173));
    expect(portsOf(a)).toEqual([3000, 5173]);
    expect(portsOf(b)).toEqual([8080]);

    setPorts(a, [{ port: 5173, pid: 7 }]);
    await until(() => !portsOf(a).includes(3000));
    expect(portsOf(a)).toEqual([5173]);
    expect(portsOf(b)).toEqual([8080]);
  }, 20_000);

  it("a listener killed and started again is listed again, even when the daemon cannot name its pid", async () => {
    const a = await firstGuest([{ port: 8412, pid: 100 }]);
    const { api } = fakeApi([view(a)], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => portsOf(a).includes(8412));

    setPorts(a, []);
    await until(() => !portsOf(a).includes(8412));

    setPorts(a, [{ port: 8412 }]);
    await until(() => portsOf(a).includes(8412), 2000);
    expect(getBrowser(a).ports()).toEqual([{ port: 8412, pid: null, process: null }]);
  }, 20_000);

  it("a redial re-subscribes: ports that changed while the channel was down are reconciled", async () => {
    const a = await firstGuest([{ port: 3000 }]);
    const { api, emit } = fakeApi([view(a)], () => relay!);
    unwire = wireTerminals(useStore, { backoffMs: () => 30 });
    useStore.getState().bind(api);
    await until(() => portsOf(a).includes(3000));

    emit({ type: "workspace.napped", workspaceId: a });
    await until(() => getTerminals(a)!.status() === "connecting");
    setPorts(a, [{ port: 4000 }]);
    await new Promise(r => setTimeout(r, 120));

    emit({ type: "workspace.woken", workspaceId: a, machineId: `m_${a}`, resurrected: false });
    await until(() => portsOf(a).includes(4000) && !portsOf(a).includes(3000));
    expect(portsOf(a)).toEqual([4000]);
  }, 20_000);
});
