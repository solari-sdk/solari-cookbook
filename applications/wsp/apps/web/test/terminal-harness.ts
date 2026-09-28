// SPDX-License-Identifier: AGPL-3.0-only
// Shared harness: a real daemon binary reached through the reach client,
// registered as the terminal link for WS_ID. Callers must run teardown() in
// afterEach.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PtyListReply, type PtyListEntry } from "@wsp/protocol";
import { connectDaemon, type DaemonReach } from "@wsp/runtime";
import { fakeProcTree, fakeStty, writeProc } from "../../../packages/daemon/test/fake-proc.js";
import { daemonUnderTest, type DaemonUnderTest } from "../../../packages/daemon/test/harness.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";

export const TOKEN = "t21-token";
export const WS_ID = "ws_term_test";

/** The foreground process group every shell this harness starts reports, so one fake entry answers for all of them. */
const FOREGROUND_PID = 7001;

let daemon: DaemonUnderTest | undefined;
let reach: DaemonReach | undefined;
let inboxDir: string | undefined;
let procRoot: string | undefined;
let savedPath: string | undefined;

export interface Harness {
  wt: WorkspaceTerminals;
  /** The ptys the daemon holds, asked over the wire the way a client asks. */
  ptys(): Promise<PtyListEntry[]>;
  /** Every op sent over the wire, in order; lets tests count pty.write calls. */
  wireLog: { op: string; params: Record<string, unknown> }[];
}

export async function boot(): Promise<Harness> {
  inboxDir = mkdtempSync(join(tmpdir(), "wsp-term-"));
  procRoot = fakeProcTree([{ pid: FOREGROUND_PID, comm: "sh" }]);
  // The mode probe reads the pty slave off fd 0 in the tree and asks stty about it. The real stty would report line
  // mode here, which holds keystrokes locally; a raw report keeps these tests on the passthrough path, and compose
  // has its own suite.
  const stty = fakeStty();
  stty.setModes("-icanon echo");
  savedPath = process.env["PATH"];
  process.env["PATH"] = `${stty.binDir}${delimiter}${savedPath ?? ""}`;
  daemon = await daemonUnderTest({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    inbox: inboxDir,
    inboxQuietMs: 100,
    inboxPollMs: 50,
    procRoot,
    portsIntervalMs: 1000,
  });
  const wireLog: Harness["wireLog"] = [];
  const wire: TerminalWire = {
    request: async (op, params = {}) => {
      wireLog.push({ op, params });
      const reply = await reach!.request(op, params);
      // The shell the daemon just started, as the fake machine shows it: its own entry with a slave on fd 0, so the
      // mode probe has something to read when the pane attaches.
      if (op === "pty.create") writeProc(procRoot!, { pid: reply["pid"] as number, comm: "sh", tpgid: FOREGROUND_PID, stdin: "/dev/pts/9" });
      return reply;
    },
  };
  const wt = new WorkspaceTerminals(wire);
  reach = connectDaemon({
    previewUrl: `ws://127.0.0.1:${daemon.port}`,
    token: TOKEN,
    heartbeatMs: 60_000,
    onEvent: e => wt.feedEvent(e),
    onStatus: s => wt.feedStatus(s),
  });
  await reach.ready;
  provideTerminals(WS_ID, wt);
  const ptys = async (): Promise<PtyListEntry[]> => PtyListReply.parse(await reach!.request("pty.list")).ptys;
  return { wt, ptys, wireLog };
}

export async function teardown(): Promise<void> {
  provideTerminals(WS_ID, null);
  reach?.close();
  reach = undefined;
  await daemon?.close();
  daemon = undefined;
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  savedPath = undefined;
  if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  inboxDir = undefined;
  if (procRoot) rmSync(procRoot, { recursive: true, force: true });
  procRoot = undefined;
}
