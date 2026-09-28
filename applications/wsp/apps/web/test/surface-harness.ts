// SPDX-License-Identifier: AGPL-3.0-only
// A fake daemon wire for the files and diff surfaces: canned replies per op,
// every call recorded, with the store holding one running workspace.
import { DAEMON_VERSION, type WorkspaceView } from "@wsp/protocol";
import { resetListings } from "../src/files/listing.js";
import { useRootStore } from "../src/files/root.js";
import { provideDaemonHello, provideDaemonWire, type DaemonHello } from "../src/files/wire.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import type { TerminalWire } from "../src/terminal/link.js";

export const WS = "ws_a";
/** What the fake daemon's hello names as its root. */
export const DAEMON_ROOT = "/root";
export const DAEMON_HELLO: DaemonHello = { root: DAEMON_ROOT, version: DAEMON_VERSION };

export const view: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m_ws_a", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
};

/** Where an imported project lands on the machine: its path on this computer, outside the daemon's home. */
export const PROJECT_DEST = "/Users/dev/wsp";
/** The same workspace after one import. */
export const imported: WorkspaceView = { ...view, project: { id: "pr_wsp", name: "wsp", path: PROJECT_DEST, computer: "default" } };

/** A canned body, or a function of the params returning one; a returned Error rejects the call with it. */
export type Reply = Record<string, unknown> | ((params: Record<string, unknown>) => Record<string, unknown> | Error);

export interface FakeWire extends TerminalWire {
  calls: [string, Record<string, unknown>][];
  replies: Record<string, Reply>;
}

export function fakeWire(replies: Record<string, Reply>): FakeWire {
  const calls: FakeWire["calls"] = [];
  const wire: FakeWire = {
    calls,
    replies,
    request: (op, params = {}) => {
      calls.push([op, params]);
      const r = wire.replies[op];
      if (r === undefined) return Promise.reject(new Error(`unknown op: ${op}`));
      const body = typeof r === "function" ? r(params) : r;
      if (body instanceof Error) return Promise.reject(body);
      return Promise.resolve({ id: 1, ok: true, ...body });
    },
  };
  return wire;
}

export function resetSurfaces(): void {
  window.localStorage.clear();
  resetListings();
  provideDaemonWire(WS, null);
  provideDaemonHello(WS, DAEMON_HELLO);
  // Every field a surface test sets goes back, not only the list: a status or a client left behind by one test was
  // read by the next one, which is a pane answering for a workspace the test before it set up.
  useStore.setState({ workspaces: [view], statuses: {}, api: null, selectedId: WS });
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useRootStore.setState({ byWorkspaceId: {} });
}

/** The one breadcrumb row both panes name their folder in: every crumb's label with the folder it goes to. */
export const folderCrumbRow = (container: HTMLElement): [string, string][] =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-folder-crumb]")).map(crumb => [crumb.textContent ?? "", crumb.dataset["folderCrumb"] ?? ""]);

/** The folder the row marks as the one shown, which is its last crumb. */
export const shownFolder = (container: HTMLElement): string | undefined =>
  container.querySelector<HTMLElement>("[data-folder-crumb][aria-current='page']")?.dataset["folderCrumb"];

const dir = (name: string) => ({ name, type: "dir", size: 0, mtime: 1 });
const file = (name: string, size = 12) => ({ name, type: "file", size, mtime: 1 });
const level = (entries: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ entries, truncated: false, total: entries.length, ...extra });

/** One reply per folder, as the daemon lists them: the root, its folders, a wide folder cut at the cap, a folder that fails. */
export const LEVELS: Record<string, Record<string, unknown>> = {
  "/root": level([dir("app"), dir("docs"), dir("locked"), dir("src"), dir("wide"), file("README.md")]),
  "/root/docs": level([file("guide.md", 5)]),
  "/root/src": level([file("a.ts")]),
  "/root/wide": level([file("w0.txt")], { truncated: true, total: 10_001 }),
  "/root/app": level([dir("lib"), file("package.json")]),
  "/root/app/lib": level([file("index.ts")]),
  [PROJECT_DEST]: level([dir("packages"), file("pnpm-workspace.yaml", 40)]),
  [`${PROJECT_DEST}/packages`]: level([dir("web")]),
};

/** The fs.list reply for a folder; a folder outside LEVELS is the daemon's not-found, the locked one its refusal. */
export const LISTING: Reply = params => {
  const path = String(params["path"]);
  if (path === "/root/locked") throw new Error("EACCES: permission denied, scandir '/root/locked'");
  const found = LEVELS[path];
  if (!found) throw Object.assign(new Error(`${path} does not exist`), { code: "not-found" });
  return found;
};
