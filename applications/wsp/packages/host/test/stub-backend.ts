// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { NODE_RELEASES } from "@wsp/catalog";
import { MCP_READ_MARK, NotFirstLifeError, SNAPSHOT_STORAGE } from "@wsp/engine";
import type { ExecResult, Lifecycle, Machine, MachineBackend, MachineLife, MachineSpec, MachineState, RunOptions, SnapshotRow, TemplateRow } from "@wsp/engine";

export interface StubMachine extends Machine {
  spec: MachineSpec;
  paused: boolean;
  killed: boolean;
  /** Every command the guest was given, exec and run alike, in order. */
  execLog: string[];
  /** The scripts that went through run(), the road for anything that may outlive one exec. */
  runLog: string[];
  /** What the provider's view says it was created at; tests move it to play a resume. */
  createdAt: string;
  /** What keeps the daemon running there; a test playing a container sets it. */
  daemonSupervisor?: Machine["daemonSupervisor"];
}

export interface StubBackend extends MachineBackend {
  /** The cloud provider's own numbers, mutable so a test shrinks one. */
  lifecycle: Lifecycle;
  machines: StubMachine[];
  execImpl: (m: StubMachine, cmd: string) => Promise<ExecResult> | ExecResult;
  /** Runs before each snapshot is taken, with which attempt on that machine this is; one that throws is the provider refusing. */
  beforeSnapshot?: (m: StubMachine, nth: number) => void;
  /** What a download URL serves for a guest path; absent, an empty archive. */
  downloads?: (path: string) => Buffer;
  /** Every snapshot taken and not deleted, as the provider would list it. */
  snapshots: SnapshotRow[];
  /** What the next snapshot is listed at; a golden measured 7.8 to 8.5 GB live. */
  snapshotBytes: number;
  listSnapshots(): Promise<SnapshotRow[]>;
  /** Every template the provider holds by id, with the snapshot each was promoted from; the capability flag is off
   * until a test turns it on, so every road without templates stays as it was. */
  templates: Map<string, TemplateRow & { snapshotId: string }>;
  /** What the key check throws when a test scripts one; without it the provider takes the key. */
  keyRefusal?: unknown;
  /** How often the key was checked, so a test proves the check happened before the first stage. */
  keyChecks: number;
  checkKey(): Promise<void>;
  /** Every promote asked, in order. */
  promoted: { snapshotId: string; name: string }[];
  promoteSnapshot(snapshotId: string, name: string): Promise<string>;
  getTemplate(id: string): Promise<TemplateRow>;
  listTemplates(): Promise<TemplateRow[]>;
  deleteTemplate(id: string): Promise<void>;
}

/** The provider's own images, which every account may name on create. */
const BUILTIN_TEMPLATES = new Set(["base", "default"]);

// Two zero blocks is a complete empty tar, so downloads are real archives.
const EMPTY_TGZ = gzipSync(Buffer.alloc(1024));

/** One loopback server per backend: GET serves the archive `downloads` gives for the path (the empty tar without it), PUT accepts anything. */
function vaultServer(downloads: () => StubBackend["downloads"]): () => Promise<string> {
  let origin: Promise<string> | undefined;
  return () =>
    (origin ??= new Promise(resolve => {
      const server = createServer((req, res) => {
        res.setHeader("connection", "close");
        if (req.method === "PUT") req.resume().on("end", () => res.writeHead(200).end());
        else {
          const body = downloads()?.(new URL(req.url!, "http://x").pathname.replace(/^\/download/, "")) ?? EMPTY_TGZ;
          res.writeHead(200, { "content-type": "application/gzip", "content-length": String(body.length) }).end(body);
        }
      });
      server.unref();
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    }));
}

/** The Node the fake's base image ships, as the real one did before the base floor. */
const BASE_NODE = "v18.20.4";

/** The MCP stage's read of every config, as a stand-in guest answers it: the text `configs` gives for a file this
 * guest holds, else that the scope has no config there. Nothing for any other command. */
export function mcpConfigRead(cmd: string, configs: (file: string) => string | undefined = () => undefined): string | undefined {
  const asks = [...cmd.matchAll(/^wsp_mcp_read (\d+) (.*)$/gm)];
  if (asks.length === 0) return undefined;
  return asks
    .map(([, scope, rest]) => {
      const files = [...rest!.matchAll(/'((?:[^']|'\\'')*)'/g)].map(m => m[1]!.replaceAll(String.raw`'\''`, "'"));
      const at = files.findIndex(f => configs(f) !== undefined);
      return at < 0 ? `${MCP_READ_MARK} ${scope} - -` : `${MCP_READ_MARK} ${scope} ${at} ${Buffer.from(configs(files[at]!)!, "utf8").toString("base64")}`;
    })
    .join("\n");
}

/** The branch the stub guest's checkout is on, and the remote's copy of it: what a fork of such a workspace
 * starts from, and what a bring back from it measures against. */
export const GUEST_BRANCH = "work";

/** What a bare guest answers: nothing, except a Node step, which keeps the base's Node when it meets the step's floor
 * and installs the pinned release when it does not, and the reach check. */
export function guestAnswer(cmd: string, configs?: (file: string) => string | undefined): ExecResult {
  if (cmd.includes("NODE_HAVE")) {
    const floor = Number(/-ge (\d+) \]/.exec(cmd)?.[1] ?? 0);
    const kept = Number(BASE_NODE.slice(1).split(".")[0]) >= floor;
    return { exitCode: 0, stdout: `NODE_HAVE ${BASE_NODE}\n${kept ? `NODE_KEPT ${BASE_NODE}` : `NODE_INSTALLED v${NODE_RELEASES[22].version}`}\n`, stderr: "" };
  }
  if (cmd === "echo ok") return { exitCode: 0, stdout: "ok\n", stderr: "" };
  const mcp = mcpConfigRead(cmd, configs);
  if (mcp !== undefined) return { exitCode: 0, stdout: `${mcp}\n`, stderr: "" };
  // The machine context probe answers with its markers and nothing found, as a bare guest would.
  if (cmd.includes("echo WSP_CTX")) return { exitCode: 0, stdout: "WSP_CTX\nWSP_CTX_END\n", stderr: "" };
  // The checkout inside a guest is on a branch the remote has, which is what a workspace forked from it starts
  // on. A guest that answered nothing here would be a machine that did not say, which the fork refuses.
  if (cmd.includes("rev-parse --abbrev-ref HEAD")) return { exitCode: 0, stdout: `${GUEST_BRANCH}\norigin/${GUEST_BRANCH}\n`, stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
}

export function stubBackend(): StubBackend {
  let seq = 0;
  const machines: StubMachine[] = [];
  const snapshots: SnapshotRow[] = [];
  const snapshotsNamed = new Map<string, number>();
  const snapshotAsks = new Map<string, number>();
  const templates: StubBackend["templates"] = new Map();
  const promoted: StubBackend["promoted"] = [];
  const vaultOrigin = vaultServer(() => backend.downloads);

  const backend: StubBackend = {
    capabilities: {
      liveCloneForks: true,
      pauseMode: "memory",
      replacesMachine: true,
      previewUrls: true,
      signedUrls: true,
      callbackRelay: true,
      diskSnapshots: true,
      images: true,
      snapshotsAnyLife: false,
      snapshotListing: true,
      templates: false,
      kept: false,
      copies: true,
      ownNetwork: true,
      sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 }, { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 }, { cpu: 4, memMb: 8192, rateUsdPerHour: 0.22 }],
    },
    pricing: { rateUsdPerHour: (s: { cpu: number; memMb: number }) => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: SNAPSHOT_STORAGE },
    lifecycle: { budgets: { wakeAttempts: 2, daemonAnswersMs: 30_000, resumeAsks: { everyMs: 60_000, forMs: 30 * 60_000 } } },
    machines,
    snapshots,
    snapshotBytes: 8_000_000_000,
    templates,
    promoted,
    keyChecks: 0,
    execImpl: (_m, cmd) => guestAnswer(cmd),
    async checkKey(): Promise<void> {
      backend.keyChecks += 1;
      if (backend.keyRefusal !== undefined) throw backend.keyRefusal;
    },
    async create(spec: MachineSpec): Promise<Machine> {
      // A key the provider will not take refuses every authenticated call, the create included.
      if (backend.keyRefusal !== undefined) throw backend.keyRefusal;
      if (spec.template !== undefined && !BUILTIN_TEMPLATES.has(spec.template) && templates.get(spec.template)?.status !== "ready") {
        throw Object.assign(new Error(`TemplateNotReady ${spec.template}`), { kind: "missing", status: 404 });
      }
      const m: StubMachine = {
        id: `m${++seq}`,
        kind: spec.kind,
        streamUrl: spec.kind === "desktop" ? `wss://stub/stream/m${seq}` : undefined,
        ...(spec.labels !== undefined ? { labels: spec.labels } : {}),
        spec,
        paused: false,
        killed: false,
        execLog: [],
        runLog: [],
        createdAt: new Date().toISOString(),
        async exec(cmd: string): Promise<ExecResult> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.execLog.push(cmd);
          return backend.execImpl(m, cmd);
        },
        async run(script: string, _opts: RunOptions): Promise<ExecResult> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.execLog.push(script);
          m.runLog.push(script);
          return backend.execImpl(m, script);
        },
        async snapshot(name: string, life: MachineLife): Promise<string> {
          // Refuses a resumed machine as the provider it stands in for does.
          if (!life.firstLife) throw new NotFirstLifeError(m.id, `snapshot ${name}`);
          snapshotAsks.set(m.id, (snapshotAsks.get(m.id) ?? 0) + 1);
          backend.beforeSnapshot?.(m, snapshotAsks.get(m.id)!);
          // The provider mints an id per call; a repeated name (two in one millisecond) must not fold into one row.
          const nth = (snapshotsNamed.get(name) ?? 0) + 1;
          snapshotsNamed.set(name, nth);
          const id = nth === 1 ? `snap_${name}` : `snap_${name}-${nth}`;
          snapshots.push({ id, name, sizeBytes: backend.snapshotBytes, createdAt: new Date().toISOString() });
          return id;
        },
        async pause(): Promise<void> {
          m.paused = true;
        },
        async resume(): Promise<void> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.paused = false;
        },
        async kill(): Promise<void> {
          m.killed = true;
        },
        async state(): Promise<MachineState> {
          return m.killed ? "gone" : m.paused ? "paused" : "running";
        },
        get seen() {
          return { state: (m.killed ? "gone" : m.paused ? "paused" : "running") as MachineState, createdAt: m.createdAt };
        },
        async downloadUrl(path: string): Promise<string> {
          return `${await vaultOrigin()}/download${path}`;
        },
        async uploadUrl(path: string): Promise<string> {
          return `${await vaultOrigin()}/upload${path}`;
        },
      };
      machines.push(m);
      return m;
    },
    async get(id: string): Promise<Machine> {
      const m = machines.find(x => x.id === id);
      if (!m || m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
      return m;
    },
    async list() {
      return machines
        .filter(m => !m.killed)
        .map(m => ({
          id: m.id,
          state: (m.paused ? "paused" : "running") as MachineState,
          labels: m.spec.labels ?? {},
        }));
    },
    // Solari refuses a snapshot with live machines forked from it (409 SnapshotHasChildren) and one a template
    // stands on (409 SnapshotBacksTemplate); forks from the template hold no such dependency.
    async deleteSnapshot(id: string): Promise<void> {
      if (machines.some(m => !m.killed && m.spec.fromSnapshot === id)) throw Object.assign(new Error("SnapshotHasChildren"), { kind: "conflict", status: 409 });
      if ([...templates.values()].some(t => t.snapshotId === id)) throw Object.assign(new Error("SnapshotBacksTemplate"), { kind: "conflict", status: 409 });
      const at = snapshots.findIndex(r => r.id === id);
      if (at >= 0) snapshots.splice(at, 1);
    },
    async listSnapshots(): Promise<SnapshotRow[]> {
      return snapshots.map(r => ({ ...r }));
    },
    async promoteSnapshot(snapshotId: string, name: string): Promise<string> {
      if (!snapshots.some(r => r.id === snapshotId)) throw Object.assign(new Error("Not found"), { kind: "missing", status: 404 });
      promoted.push({ snapshotId, name });
      const id = `tpl_${name}`;
      templates.set(id, { id, name, status: "ready", snapshotId });
      return id;
    },
    async getTemplate(id: string): Promise<TemplateRow> {
      const t = templates.get(id);
      if (t === undefined) throw Object.assign(new Error("Not found"), { kind: "missing", status: 404 });
      const { snapshotId: _s, ...row } = t;
      return row;
    },
    async listTemplates(): Promise<TemplateRow[]> {
      return [...templates.values()].map(({ snapshotId: _s, ...row }) => row);
    },
    async deleteTemplate(id: string): Promise<void> {
      if (!templates.delete(id)) throw Object.assign(new Error("Not found"), { kind: "missing", status: 404 });
    },
  };
  return backend;
}
