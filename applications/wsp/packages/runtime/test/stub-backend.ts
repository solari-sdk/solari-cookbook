import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { fakeCopier, LocalBackend, NotFirstLifeError, SNAPSHOT_STORAGE } from "@wsp/engine";
import type { ExecResult, Lifecycle, Machine, MachineBackend, MachineLife, MachineShape, MachineSpec, MachineState, RunOptions, SnapshotRow, TemplateRow } from "@wsp/engine";
import { DAEMON_TOKEN_PATH, HERE_PLACE_ID, scopeOf, type Caller, type ProjectView } from "@wsp/protocol";
import type { CreatedWorkspace, CreateWorkspaceOptions, LocalWiring, Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { DAEMON_TOKEN_SET } from "../src/daemon-token.js";

/** The branch the stub guest's checkout is on, and the remote's copy of it: what a workspace forked from such a
 * guest starts on, and what a bring back from it measures against. A guest that answered nothing to the branch
 * read would be a machine that did not say, which a fork refuses. */
export const GUEST_BRANCH = "work";

/** What every stub guest answers whatever else it is told: the branch read, since a create with a parent makes it
 * before it mints anything. Written once here so a test that wants another answer overrides that one line. */
export const guestBranchAnswer = (cmd: string): ExecResult | undefined =>
  cmd.includes("rev-parse --abbrev-ref HEAD") ? { exitCode: 0, stdout: `${GUEST_BRANCH}\norigin/${GUEST_BRANCH}\n`, stderr: "" } : undefined;

/** An execImpl for a guest that has a daemon: the runtime's token write lands and everything else is silently
 * fine. Written once here, since a reach, a channel and a relay all need the same guest to exist. */
export const tokenGuest = (_m: unknown, cmd: string): ExecResult =>
  cmd.includes(DAEMON_TOKEN_PATH)
    ? { exitCode: 0, stdout: `${DAEMON_TOKEN_SET}\n`, stderr: "" }
    : (guestBranchAnswer(cmd) ?? { exitCode: 0, stdout: "", stderr: "" });

export interface StubMachine extends Machine {
  spec: MachineSpec;
  paused: boolean;
  killed: boolean;
  /** The host lost the VM while the gateway still lists it running: metrics answer 404, the state read still says running. */
  hostLost: boolean;
  /** Every command the guest was given, exec and run alike, in order. */
  execLog: string[];
  /** The scripts that went through run(), the road for anything that may outlive one exec. */
  runLog: string[];
  /** The options each run() carried, in runLog order. */
  runOptions: RunOptions[];
  resumes: number;
  /** What describe() reports; tests mutate it to play a resume that rebuilt the VM. */
  shape: MachineShape;
  /** The life every snapshot was handed, in order. */
  snapshotLives: MachineLife[];
  metrics(): Promise<void>;
}

/** The gateway's copy that never held the machine, as it answered on 2026-09-26: it takes the first delete with the
 * same yes and does nothing, so the machine runs on until a delete reaches the copy that holds it. */
export function missesFirstDelete(m: StubMachine): void {
  const kill = m.kill.bind(m);
  let missed = false;
  m.kill = async () => {
    if (missed) return kill();
    missed = true;
  };
}

/** The gateway's copy that never held the machine answering one read, as it did on 2026-09-26: the first read of
 * `m` once `when` holds, by the backend or the handle, is a 404 while the machine runs on at the other copy. */
export function answersGoneOnce(backend: StubBackend, m: StubMachine, when: () => boolean = () => true): void {
  let lied = false;
  const lie = (): boolean => !lied && when() && (lied = true);
  const get = backend.get.bind(backend);
  backend.get = async id => {
    if (id === m.id && lie()) throw Object.assign(new Error("Not found"), { kind: "missing", status: 404 });
    return get(id);
  };
  const state = m.state.bind(m);
  m.state = async () => (lie() ? "gone" : state());
}

/** The failure a call the caller's own signal cut off raises; the runtime reads it as neither of the two typed move
 * failures, which is what makes a stopped wake end as stopped rather than as a provider that did not answer. */
export const abortedCall = (what: string): Error => Object.assign(new Error(`${what} was aborted`), { name: "AbortError" });

export interface StubBackend extends MachineBackend {
  /** The cloud provider's own numbers, mutable so a test shrinks or removes one. */
  lifecycle: Lifecycle;
  machines: StubMachine[];
  /** Every command run on the computer itself rather than in a workspace on it, oldest first: what a computer the
   * person owns answers, set by the test that stands one up beside `projects`. */
  computerLog: string[];
  /** Every body PUT to an upload URL the stub minted, with the machine and guest path it was for. */
  puts: { machine: string; path: string; body: Buffer }[];
  /** What a download URL serves for a guest path; absent, an empty archive. */
  downloads?: (path: string) => Buffer;
  /** What the computer answers a create with beside the machine, as a box that would not fork at the size asked for
   * does; absent, every create answers with the machine alone. Set before a machine is made. */
  createNotice?: string;
  execImpl: (m: StubMachine, cmd: string) => Promise<ExecResult> | ExecResult;
  /** Runs before each snapshot is taken, with which attempt on that machine this is; one that throws is the provider refusing. */
  beforeSnapshot?: (m: StubMachine, nth: number) => void;
  /** Every snapshot taken and not deleted, as the provider would list it. */
  snapshots: SnapshotRow[];
  /** What the next snapshot is listed at; a golden measured 7.8 to 8.5 GB live. */
  snapshotBytes: number;
  listSnapshots(): Promise<SnapshotRow[]>;
  /** Every template the provider holds by id, with the snapshot each was promoted from; the capability flag is off
   * until a test turns it on, so every road without templates stays as it was. */
  templates: Map<string, TemplateRow & { snapshotId: string }>;
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

/** One loopback server per backend: GET serves the archive `downloads` gives for the path (the empty tar without it), PUT accepts anything and records it. */
function vaultServer(puts: StubBackend["puts"], downloads: () => StubBackend["downloads"]): () => Promise<string> {
  let origin: Promise<string> | undefined;
  return () =>
    (origin ??= new Promise(resolve => {
      const server = createServer((req, res) => {
        res.setHeader("connection", "close");
        if (req.method === "PUT") {
          const url = new URL(req.url!, "http://x");
          const chunks: Buffer[] = [];
          req.on("data", c => chunks.push(c as Buffer));
          req.on("end", () => {
            puts.push({ machine: url.searchParams.get("machine")!, path: url.searchParams.get("path")!, body: Buffer.concat(chunks) });
            res.writeHead(200).end();
          });
        } else {
          const body = downloads()?.(new URL(req.url!, "http://x").pathname.replace(/^\/download/, "")) ?? EMPTY_TGZ;
          res.writeHead(200, { "content-type": "application/gzip", "content-length": String(body.length) }).end(body);
        }
      });
      server.unref();
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    }));
}

/** `mark` goes into every snapshot id this backend mints. Two stubs standing for two places mint ids a test can tell
 * apart, which is what lets an assertion about which place's copy a fork names go red. Unmarked ids are what every
 * caller with one backend has always read. */
export function stubBackend(mark?: string): StubBackend {
  let seq = 0;
  const machines: StubMachine[] = [];
  const snapshots: SnapshotRow[] = [];
  const snapshotsNamed = new Map<string, number>();
  const snapshotAsks = new Map<string, number>();
  const templates: StubBackend["templates"] = new Map();
  const promoted: StubBackend["promoted"] = [];
  const puts: StubBackend["puts"] = [];
  const computerLog: string[] = [];
  const vaultOrigin = vaultServer(puts, () => backend.downloads);

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
      sizes: [{ cpu: 2, memMb: 2048, rateUsdPerHour: 0.09 }, { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 }, { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 }, { cpu: 4, memMb: 8192, rateUsdPerHour: 0.22 }],
    },
    pricing: { rateUsdPerHour: (s: { cpu: number; memMb: number }) => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: SNAPSHOT_STORAGE },
    lifecycle: { budgets: { wakeAttempts: 2, daemonAnswersMs: 30_000, resumeAsks: { everyMs: 60_000, forMs: 30 * 60_000 } } },
    machines,
    computerLog,
    puts,
    snapshots,
    snapshotBytes: 8_000_000_000,
    templates,
    promoted,
    // The machine context probe answers with its markers and nothing found, as a bare guest would.
    execImpl: (_m, cmd) => guestBranchAnswer(cmd) ?? { exitCode: 0, stdout: cmd.includes("echo WSP_CTX") ? "WSP_CTX\nWSP_CTX_END\n" : "", stderr: "" },
    // One command on the computer itself, outside every workspace: recorded apart from any machine's log, since
    // that is what it is, and answered by the same execImpl a machine's exec goes through so a test sets one
    // answer for both. The machine handed to that answer stands for the computer and is in no listing.
    async onComputer(cmd: string): Promise<ExecResult> {
      computerLog.push(cmd);
      return backend.execImpl({ id: "computer", execLog: computerLog } as StubMachine, cmd);
    },
    async create(spec: MachineSpec): Promise<Machine> {
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
        hostLost: false,
        execLog: [],
        runLog: [],
        runOptions: [],
        resumes: 0,
        shape: { cpu: spec.cpu ?? 2, memMb: spec.memMb ?? 4096, createdAt: new Date().toISOString() },
        snapshotLives: [],
        ...(backend.createNotice !== undefined ? { notice: backend.createNotice } : {}),
        async exec(cmd: string): Promise<ExecResult> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.execLog.push(cmd);
          return backend.execImpl(m, cmd);
        },
        async run(script: string, opts: RunOptions): Promise<ExecResult> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.execLog.push(script);
          m.runLog.push(script);
          m.runOptions.push(opts);
          return backend.execImpl(m, script);
        },
        async snapshot(name: string, life: MachineLife): Promise<string> {
          m.snapshotLives.push(life);
          // The provider's own row says which life a copy may be taken from; the stub refuses the same one it declares.
          if (!life.firstLife && !backend.capabilities.snapshotsAnyLife) throw new NotFirstLifeError(m.id, `snapshot ${name}`);
          snapshotAsks.set(m.id, (snapshotAsks.get(m.id) ?? 0) + 1);
          backend.beforeSnapshot?.(m, snapshotAsks.get(m.id)!);
          // The provider mints an id per call; a repeated name (two in one millisecond) must not fold into one row.
          const nth = (snapshotsNamed.get(name) ?? 0) + 1;
          snapshotsNamed.set(name, nth);
          const at = mark === undefined ? "" : `${mark}-`;
          const id = nth === 1 ? `snap_${at}${name}` : `snap_${at}${name}-${nth}`;
          snapshots.push({ id, name, sizeBytes: backend.snapshotBytes, createdAt: new Date().toISOString() });
          return id;
        },
        async pause(): Promise<void> {
          m.paused = true;
        },
        async resume(): Promise<void> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.resumes++;
          m.paused = false;
        },
        async kill(): Promise<void> {
          m.killed = true;
        },
        async state(): Promise<MachineState> {
          return m.killed ? "gone" : m.paused ? "paused" : "running";
        },
        get seen() {
          return { state: (m.killed ? "gone" : m.paused ? "paused" : "running") as MachineState, ...(m.shape.createdAt !== undefined ? { createdAt: m.shape.createdAt } : {}) };
        },
        async describe(): Promise<MachineShape> {
          return { ...m.shape };
        },
        async metrics(): Promise<void> {
          if (m.killed || m.hostLost) throw Object.assign(new Error("host no longer knows this VM"), { kind: "missing", status: 404 });
        },
        async downloadUrl(path: string): Promise<string> {
          return `${await vaultOrigin()}/download${path}`;
        },
        async uploadUrl(path: string): Promise<string> {
          return `${await vaultOrigin()}/upload?machine=${m.id}&path=${encodeURIComponent(path)}`;
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

/** The project every workspace in a test stands on. A workspace is one project's copy, so a test that is about a
 * nap, a status or a thread still needs one; this is the one line that makes it, and the one place the shape of a
 * project record is written down for the tests. `computer` is the row it lives on, the provider this host forks
 * on by default; `source` is the repo a copy of that computer clones. */
export async function projectOn(rt: ProjectMaker, computer?: string, source?: string, named?: { name?: string; base?: string }): Promise<ProjectView> {
  // The computer a test never names is the one this host forks at, read off the places table so a runtime with a
  // place door and one without both land somewhere real.
  const on = computer ?? (await forkingComputer(rt));
  // This computer works a folder of the person's own in place and takes no url, so a project here is a real repo
  // in a folder of its own; every other computer clones. One source on one computer is one project, so the repo a
  // test never names is a fresh one each call: two workspaces in one test are two projects.
  return rt.projects.add({ source: source ?? (on === HERE_PLACE_ID ? tempRepo() : `https://github.com/wsp/stub-${++stubs}.git`), on, ...named });
}

/** The computer a test's workspaces land on when it names none: the first row that takes forks, else the first
 * provider, else the one a host wired without places forks at. */
async function forkingComputer(rt: ProjectMaker): Promise<string> {
  const rows = await rt.projects.computers();
  return (rows.find(r => r.id !== HERE_PLACE_ID) ?? rows[0])!.id;
}

let stubs = 0;

/** A git repo in a folder of its own, for a project on this computer: `wsp add <folder>` refuses a folder that is
 * not the top of one, so a test that wants a project here makes one. */
export function tempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wsp-project-")));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

/** A workspace of a fresh project, for every test whose subject is the workspace and not the project: `on` names
 * the computer the project lives on, and a test that has a project already passes its id as `project`. Built on
 * projectOn, so the project a test never names is still a real record with a real computer behind it. */
export async function createOn(rt: ProjectMaker & WorkspaceMaker, o: CreateOn, origin?: Caller): Promise<CreatedWorkspace> {
  const { on, project, ...rest } = o;
  // A thread works on its own project alone, so a fork a thread asks for is of the project its own workspace
  // holds; a test that means another names it. Read here rather than in every case, since a fresh project per
  // call is what a test that never names one gets.
  const scope = scopeOf(origin);
  const own = scope === undefined ? undefined : (await rt.workspaces.get(scope.workspaceId, origin)).project.id;
  const id = project ?? own ?? (await projectOn(rt, on)).id;
  return rt.workspaces.create({ ...rest, project: id }, origin);
}

export type CreateOn = Omit<CreateWorkspaceOptions, "project"> & { project?: string; on?: string };
type ProjectMaker = { projects: Pick<Runtime["projects"], "add" | "computers"> };
type WorkspaceMaker = { workspaces: Pick<Runtime["workspaces"], "create" | "get"> };

/** The computer this suite is running on, in the two words every line that names this computer takes. Read rather
 * than written down: the landing gate runs on a Mac and ci runs on Linux, and a literal here would pin the word
 * one of them reads. */
export const testPlatform = (): "darwin" | "linux" => (process.platform === "darwin" ? "darwin" : "linux");

/** This computer as a test wires it: a LocalBackend rooted in a folder of the test's own, so a project here is a
 * real folder and the exec that reads whether it is a repo runs where the test can see it. Written here beside
 * the fixtures because three test files need the same wiring and a second copy of it drifts. */
export function fakeLocal(root: string): LocalWiring {
  return {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier: copyingFake(),
  };
}

/** The copy road as a test wires it: the engine's fake, which records every ask, over a folder copied for real, so
 * a thread or a command on the copy has a folder to start in and a delete takes it away. Every workspace on this
 * computer is a copy, so every wiring that makes one carries this. */
export function copyingFake(): ReturnType<typeof fakeCopier> {
  const inner = fakeCopier(ask => {
    cpSync(ask.from, ask.to, { recursive: true });
    return { road: ask.road ?? "clonefile", path: ask.to, base: "0".repeat(40), branch: "main", fetched: true, carried: "deps-and-config", excluded: [...ask.exclude], bytes: 1024, ms: 1 };
  });
  return {
    ...inner,
    remove: async (from, to, road) => {
      await inner.remove(from, to, road);
      rmSync(to, { recursive: true, force: true });
    },
  };
}
