// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the export dialog for a running workspace
// over a fake api, in either theme (?theme=light), the thread's folder already
// known, three agents with threads (?threads=0 for none), as the desktop shell
// shows it. Export plays the runtime's events a beat apart, the folder's
// download and then the agents' state as the runtime does it, and then
// resolves; with ?exists=1
// the first request is refused because the destination is already here, so a
// test can lay out and photograph the refusal, then Replace and export; with
// ?long=1 the folder sits at a 120-character path with no space in it, so the
// refusal that begins with it has to wrap.
import { createRoot } from "react-dom/client";
import type { EventUnion, ProjectExportEvent, ProjectExportResult, SessionView, WorkspaceView } from "@wsp/protocol";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { useRootStore } from "../../src/files/root";
import { RequestError, type Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import { ExportProjectDialog } from "../../src/sidebar/ExportProjectDialog";
import { fakeHostFolders } from "../host-folders-fixture";
import "../../src/index.css";
import "../../src/themes/index";
import { caps } from "../caps.js";
import { noDaemonApi } from "../fake-daemon-api.js";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
// The desktop shell's bridge, so the picker button is laid out; nothing here opens a system dialog. With ?tab=1
// there is no bridge, which is a browser tab: the folder browser over the host's own folders stands there instead.
const TAB = params.get("tab") === "1";
if (!TAB) window.wsp = { pickFolder: async () => undefined };

const SOURCE = params.get("long") === "1" ? "/Users/me/code/clients/northwind-traders/platform/services/billing-reconciliation/workers/nightly-settlements-batch/spoo" : "/Users/me/code/spoo";
const workspace: WorkspaceView = { id: "ws_api", name: "api", machineId: "m_api", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-05T11:00:00Z" };
const session = (id: string, harness: string): SessionView => ({ id, workspaceId: workspace.id, harness, status: "completed", threadId: `t_${id}`, cwd: SOURCE });
const landed: ProjectExportResult = {
  dest: SOURCE,
  files: 1_202,
  bytes: 38.0 * 1024 * 1024,
  excluded: ["node_modules", "dist", ".venv", "coverage"],
  agents: [
    { agent: "claude", files: 14, bytes: 1_204_000, outcome: "moved", sessions: 6 },
    { agent: "codex", files: 3, bytes: 88_000, outcome: "transcript-only", sessions: 2, skipped: 1 },
    { agent: "gemini", files: 0, bytes: 0, outcome: "nothing" },
  ],
};

const listeners = new Set<(e: EventUnion) => void>();
const emit = (over: Partial<ProjectExportEvent>): void => {
  const e: EventUnion = { type: "project.export", workspaceId: workspace.id, source: SOURCE, dest: SOURCE, stage: "packing", message: "", elapsedMs: 0, ...over };
  listeners.forEach(fn => fn(e));
};
const beat = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
let refusals = params.get("exists") === "1" ? 1 : 0;

const api: Api = {
  listWorkspaces: async () => [workspace],
  getWorkspace: async () => workspace,
  createWorkspace: async () => workspace,
  watchStatuses: async () => [],
  nap: async () => workspace,
  wake: async () => workspace,
  capabilities: async () => (caps()),
  startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemon: noDaemonApi,
  sessionHistory: async () => [],
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listSessions: async () => (params.get("threads") === "0" ? [] : [session("s1", "claude"), session("s2", "codex"), session("s3", "claude"), session("s4", "gemini")]),
  getGolden: async () => undefined,
  hostFolders: fakeHostFolders(),
  exportProject: async o => {
    if (refusals > 0 && o.replace !== true) {
      refusals--;
      throw new RequestError(`${o.dest} already exists on this computer with 1204 files; export with replace to overwrite it`, "exists");
    }
    emit({ stage: "packing", message: `Packing ${SOURCE} on the machine.`, elapsedMs: 120 });
    await beat(150);
    emit({ stage: "downloading", message: "The folder: 0 B of 31 MB.", elapsedMs: 2_400, bytes: 0, total: 32_505_856 });
    await beat(150);
    emit({ stage: "downloading", message: "The folder: 16 MB of 31 MB.", elapsedMs: 4_600, bytes: 16_252_928, total: 32_505_856 });
    await beat(150);
    emit({ stage: "downloading", message: "The folder: 31 MB of 31 MB.", elapsedMs: 6_900, bytes: 32_505_856, total: 32_505_856 });
    await beat(150);
    emit({ stage: "packing", message: "Packing the agents' state for it on the machine.", elapsedMs: 7_000 });
    await beat(150);
    emit({ stage: "downloading", message: "Agent state: 0 B of 1 MB.", elapsedMs: 7_100, bytes: 0, total: 1_292_000 });
    await beat(150);
    emit({ stage: "downloading", message: "Agent state: 1 MB of 1 MB.", elapsedMs: 7_400, bytes: 1_292_000, total: 1_292_000 });
    await beat(150);
    emit({ stage: "landing", message: `Landing at ${o.dest}.`, elapsedMs: 7_500 });
    await beat(150);
    emit({ stage: "done", message: `1202 files, 38 MB, landed at ${o.dest}; 4 caches left behind; sessions: Claude Code (6 sessions) moved, Codex (2 sessions) transcripts landed but not yet in its session list here, 1 indexed rollout not under sessions/ skipped, Gemini CLI had nothing to bring.`, elapsedMs: 9_800 });
    return { ...landed, dest: o.dest };
  },
  subscribe: fn => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

useStore.setState({ conn: "live", workspaces: [workspace] });
useRootStore.getState().follow(workspace.id, SOURCE);
useStore.getState().bind(api);
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <div className="h-full bg-background text-foreground">
      <ExportProjectDialog workspace={workspace} onClose={() => {}} />
    </div>
  </TooltipProvider>,
);
