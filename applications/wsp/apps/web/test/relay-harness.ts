// SPDX-License-Identifier: AGPL-3.0-only
// The road a pane really takes: a real daemon binary, a runtime whose stub
// machines answer with a daemon's address, a served host socket, and the
// page's own client over it. Nothing here fakes the relay; a test that goes
// live has driven a pty through two sockets.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyListReply, rootsPathIn, type PtyListEntry } from "@wsp/protocol";
import { connectDaemon, createRuntime, memoryStore, serveRuntime, type DaemonReach, type Runtime, type RuntimeServer } from "@wsp/runtime";
import { fakeProcTree, setListeners, writeSys, type FakeListener, type FakeProc, type FakeSys } from "../../../packages/daemon/test/fake-proc.js";
import { daemonUnderTest, machineDaemonToken, type DaemonArgs, type DaemonUnderTest } from "../../../packages/daemon/test/harness.js";
import { stubBackend, tokenGuest, type StubBackend } from "../../../packages/runtime/test/stub-backend.js";
import { makeApi, ProtocolClient, type Api } from "../src/protocol/client.js";
import { createOn } from "../../../packages/runtime/test/stub-backend.js";

const HOST_TOKEN = "relay-harness-host-token";
const DAEMON_TOKEN = "cafef00d".repeat(3);

/** This harness's seed read for one machine, which a test writes to a token file to play a machine that starts
 * refusing this host's token and then takes it. */
export const harnessMachineToken = (machineId: string): string => machineDaemonToken(DAEMON_TOKEN, machineId);

export interface RelayHarness {
  api: Api;
  client: ProtocolClient;
  daemon: DaemonUnderTest;
  /** The fake machine the daemon reads: a listener written here is a port.open on its next poll. */
  procRoot: string;
  /** The ptys the guest's daemon holds, asked over the wire the way a client asks. */
  ptys(): Promise<PtyListEntry[]>;
  runtime: Runtime;
  server: RuntimeServer;
  backend: StubBackend;
  workspaceId: string;
  /** Where the host dials for one workspace; a test moves it to play a door, a proxy or a machine that is gone. */
  setRoad(url: string, workspaceId?: string): void;
  /** One more workspace on this same host, whose machine answers at `url`. */
  addWorkspace(name: string, url: string): Promise<string>;
  close(): Promise<void>;
}

export interface RelayHarnessOptions {
  /** The token the daemon takes, so a test can play a host whose token the machine refuses. */
  daemonToken?: string;
  /** A file the daemon reads its token from on every auth frame, for a machine whose token changes under the link. */
  tokenPath?: string;
  /** Where the host dials instead of the daemon: a refusing door, a proxy, a port nothing listens on. */
  road?: (daemonPort: number) => string;
  /** What is listening on the guest to begin with; a test writes more into procRoot as it goes. */
  ports?: readonly FakeListener[];
  /** The processes the guest is running, which the Processes tab reads. */
  procs?: readonly FakeProc[];
  /** The load the guest reports, which the Machine tab's Live rows read. */
  sys?: FakeSys;
  /** Anything else the guest's daemon is started with: its root, an open socket, a sampling clock. */
  daemonArgs?: DaemonArgs;
}

export async function startRelayHarness(opts: RelayHarnessOptions = {}): Promise<RelayHarness> {
  const inboxDir = mkdtempSync(join(tmpdir(), "wsp-relay-inbox-"));
  // The machine this daemon reads is a fake /proc tree: darwin has none, and a listener is a row written into it.
  const procRoot = fakeProcTree([...(opts.procs ?? [])]);
  if (opts.sys !== undefined) writeSys(procRoot, opts.sys);
  if (opts.ports !== undefined) setListeners(procRoot, opts.ports);
  // Its roots file goes in a folder this test owns: the flag's default names the guest's /root, another user's folder here.
  const daemon = await daemonUnderTest({
    host: "127.0.0.1",
    port: 0,
    ...(opts.tokenPath !== undefined ? { tokenPath: opts.tokenPath } : { token: opts.daemonToken ?? harnessMachineToken("m1") }),
    inbox: inboxDir,
    rootsPath: rootsPathIn(inboxDir),
    procRoot,
    portsIntervalMs: 50,
    ...opts.daemonArgs,
  });

  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  const runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN });
  const server = await serveRuntime(runtime, { port: 0, authToken: HOST_TOKEN });

  const roads = new Map<string, string>();
  const add = async (name: string, url: string): Promise<string> => {
    const at = backend.machines.length;
    const workspace = await createOn(runtime, { golden: "snap_g", name });
    roads.set(workspace.id, url);
    // Minted just inside the engine's refresh margin, so every dial reads the road as it stands now: a test that
    // moves it is playing an edge whose answer changed, which is the wall this exists for.
    backend.machines[at]!.previewUrl = async () => ({ url: roads.get(workspace.id)!, token: "e", expiresAt: Date.now() + 60_000 });
    return workspace.id;
  };
  const workspaceId = await add("relay", opts.road?.(daemon.port) ?? `ws://127.0.0.1:${daemon.port}`);

  const client = new ProtocolClient({ url: `ws://127.0.0.1:${server.port}`, token: HOST_TOKEN });
  await client.connect();

  // A link of this test's own to the guest's daemon, for what a test reads of the daemon rather than of the page.
  let own: DaemonReach | undefined;
  const ptys = async (): Promise<PtyListEntry[]> => {
    own ??= connectDaemon({ previewUrl: `ws://127.0.0.1:${daemon.port}`, token: opts.daemonToken ?? harnessMachineToken("m1"), onEvent: () => {} });
    await own.ready;
    return PtyListReply.parse(await own.request("pty.list")).ptys;
  };

  return {
    api: makeApi(client),
    client,
    daemon,
    procRoot,
    ptys,
    runtime,
    server,
    backend,
    workspaceId,
    setRoad(url, id = workspaceId) {
      roads.set(id, url);
    },
    addWorkspace: add,
    async close() {
      own?.close();
      client.close();
      await server.close();
      await runtime.close();
      await daemon.close();
      rmSync(inboxDir, { recursive: true, force: true });
      rmSync(procRoot, { recursive: true, force: true });
    },
  };
}
