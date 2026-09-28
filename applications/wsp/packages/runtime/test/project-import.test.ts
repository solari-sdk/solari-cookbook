// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarOf } from "@wsp/engine";
import { tarRead } from "../../engine/test/tar-read.js";
import type { EventUnion, HostFolderListing, ProjectAgent, ProjectAgentOutcome, ProjectImportEvent, ProjectPlan, ProjectSecret } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type PackedProject, type PackedState, type ProjectBundler, type StateRequest } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";
import { wsRequest } from "./ws-client.js";

const dirs: string[] = [];
let srv: RuntimeServer | undefined;
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await srv?.close();
  srv = undefined;
});

const BINARY = Buffer.concat([Buffer.from("#!/bin/sh\necho run\n"), randomBytes(2048), Buffer.from([0x00, 0xff, 0x0a])]);
const SOURCE = "/Users/dev/code/proj";

const GIT_CONFIG: ProjectSecret = { path: ".git/config", bytes: 300, signals: ["url"], rewrite: { urls: ["https://github.com/example/proj.git"], drop: [] } };
const AUTH_CONFIG: ProjectSecret = { path: ".git/config", bytes: 300, signals: ["keys", "url"], rewrite: { urls: ["https://github.com/example/proj.git"], drop: ["http.extraheader"] } };

const AGENTS: ProjectAgent[] = [
  { agent: "claude", name: "Claude Code", sessions: 2, bytes: 4096, carry: "moves" },
  { agent: "pi", name: "Pi", sessions: 1, bytes: 512, carry: "moves" },
  { agent: "codex", name: "Codex", sessions: 3, bytes: 900, carry: "transcript-only" },
];
/** An agent whose state for the folder is rows alone: nothing to land as a file, a merge to run. */
const HERMES: ProjectAgent = { agent: "hermes", name: "Hermes Agent", sessions: 1, bytes: 0, carry: "transcript-only" };
const MERGE_DIR = "/tmp/wsp-merge-0000";
const mergeCommand = (agent: string): string => `python3 '${MERGE_DIR}/${agent}.py'`;
/** The exec that takes the script away once its run ended, however it ended. */
const removeCommand = (agent: string): string => `rm -f '${MERGE_DIR}/${agent}.py'; rmdir '${MERGE_DIR}' 2>/dev/null`;

/** What the host would hand the runtime for a small folder: three secret-shaped files, one binary with an exec bit,
 * and, when asked, agents with sessions for it; the state pack lands one file per agent with bytes under its machine
 * home, and a merge script for each agent on the machine whose rows stay in a shared store. */
function fakeBundler(extra: ProjectSecret[] = [], agents: ProjectAgent[] = []): ProjectBundler & { calls: string[] } {
  const plan: ProjectPlan = {
    source: SOURCE,
    repo: true,
    files: 6,
    bytes: 4321,
    secrets: [
      { path: ".env", bytes: 20, signals: ["name", "keys"] },
      ...extra,
      { path: "config/secrets.json", bytes: 25, signals: ["name", "keys"] },
      { path: "keys/id_ed25519", bytes: 80, signals: ["name", "mode", "pem"] },
    ],
    excluded: ["dist", "node_modules"],
    skipped: [],
    agents,
  };
  const calls: string[] = [];
  return {
    calls,
    plan: async () => {
      calls.push("plan");
      return plan;
    },
    pack: async (carry, rewrite): Promise<PackedProject> => {
      calls.push(`pack ${[...carry].join(",")}${rewrite.size > 0 ? ` rewrite ${[...rewrite].join(",")}` : ""}`);
      const rewritten = plan.secrets.filter(s => s.rewrite !== undefined && rewrite.has(s.path)).map(s => s.path);
      const cut = plan.secrets.map(s => s.path).filter(p => !carry.has(p) && !rewritten.includes(p));
      const tar = tarOf([
        { path: "bin", mode: 0o755, dir: true },
        { path: "bin/run.sh", mode: 0o755, content: BINARY },
        { path: "src/index.ts", mode: 0o644, content: "export const a = 1;\n" },
        ...plan.secrets.filter(s => carry.has(s.path) || rewritten.includes(s.path)).map(s => ({ path: s.path, mode: 0o600, content: `${s.path} body\n` })),
      ]);
      return { tar, files: plan.files - cut.length, bytes: 4000, cut, rewritten };
    },
    packState: async (req): Promise<PackedState> => {
      calls.push(`state ${req.agents.map(a => `${a.agent}${a.present ? "+" : "-"}`).join(",")} to ${req.dest}`);
      const planned = (id: string): ProjectAgent | undefined => agents.find(x => x.agent === id);
      const files = req.agents.filter(a => (planned(a.agent)?.bytes ?? 0) > 0).map(a => ({ agent: a.agent, path: `${a.home}/sessions/${a.agent}.jsonl`, mode: 0o600, content: `${a.agent} at ${a.present ? req.dest : SOURCE}\n` }));
      const merges = req.agents.filter(a => a.present && planned(a.agent)?.carry === "transcript-only").map(a => ({ agent: a.agent, script: `${MERGE_DIR}/${a.agent}.py` }));
      const outcome = (a: StateRequest["agents"][number]): ProjectAgentOutcome => (!a.present ? "carried" : planned(a.agent)?.carry === "moves" ? "moved" : "transcript-only");
      return {
        tar: tarOf([...files, ...merges.map(m => ({ path: m.script, mode: 0o600, content: "print()\n" }))]),
        agents: req.agents.map(a => ({ agent: a.agent, files: files.filter(f => f.agent === a.agent).length, bytes: files.filter(f => f.agent === a.agent).reduce((n, f) => n + f.content.length, 0), outcome: outcome(a) })),
        merges,
      };
    },
  };
}

const extract = (tgz: Buffer): string => {
  const dir = mkdtempSync(join(tmpdir(), "wsp-import-out-"));
  dirs.push(dir);
  tarRead(["-xzf", "-", "-C", dir], tgz);
  return dir;
};

const imports = (events: EventUnion[]): ProjectImportEvent[] => events.filter((e): e is ProjectImportEvent => e.type === "project.import");

describe("project.import on a workspace", () => {
  it("plans, says what was consented, packs, uploads the archive whole, lands it at the path and reports done", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    // The create uploaded the machine context; the import's PUT is the one after it.
    const before = backend.puts.length;
    const bundler = fakeBundler();
    const result = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/work/proj", carry: [".env"], bundler });
    expect(bundler.calls).toEqual(["plan", "pack .env"]);
    expect(result).toEqual({ dest: "/root/work/proj", files: 4, bytes: 4000, parts: 1, cut: ["config/secrets.json", "keys/id_ed25519"], rewritten: [], agents: [], project: { name: "proj", dest: "/root/work/proj", importedAt: expect.any(String), size: 4000 } });
    const stages = imports(events);
    expect(stages.map(e => e.stage)).toEqual(["planned", "consented", "packing", "uploading", "uploading", "landing", "done"]);
    expect(stages[0]!.message).toBe("6 files, 4 KB and the repository; 3 secret-shaped files; 2 caches left behind.");
    expect(stages[1]!.message).toBe("Carrying .env; cut config/secrets.json, keys/id_ed25519.");
    expect(stages[2]!.message).toBe("Packing 4 files.");
    expect(stages[3]).toMatchObject({ bytes: 0, total: expect.any(Number) });
    expect(stages[4]).toMatchObject({ bytes: stages[3]!.total, total: stages[3]!.total });
    expect(stages[5]!.message).toBe("Landing at /root/work/proj.");
    expect(stages[6]!.message).toBe("4 files, 4 KB, landed at /root/work/proj.");
    for (const e of stages) expect(e).toMatchObject({ workspaceId: ws.id, source: SOURCE, dest: "/root/work/proj", elapsedMs: expect.any(Number) });
    expect(backend.puts).toHaveLength(before + 1);
    const body = backend.puts[before]!.body;
    expect(body.length).toBe(stages[3]!.total);
    const out = extract(body);
    expect(readFileSync(join(out, "bin/run.sh")).equals(BINARY)).toBe(true);
    expect(statSync(join(out, "bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(out, ".env"), "utf8")).toBe(".env body\n");
    expect(existsSync(join(out, "config/secrets.json"))).toBe(false);
    const machine = backend.machines[0]!;
    expect(machine.execLog.some(c => c.startsWith("test -e '/root/work/proj'"))).toBe(true);
    const untar = machine.runLog.filter(s => s.includes("tar xzf")).at(-1)!;
    expect(untar).toMatch(/mkdir -p '\/root\/work\/proj\.wsp-in-[^']+'\n.*tar xzf - -C '\/root\/work\/proj\.wsp-in-[^']+' --no-same-owner/);
    const landing = machine.runLog.find(s => s.includes("mv "))!;
    expect(landing).toContain("mkdir -p '/root/work'");
    expect(landing).toMatch(/test ! -e '\/root\/work\/proj' \|\| exit 66\nmv '\/root\/work\/proj\.wsp-in-[^']+' '\/root\/work\/proj'/);
    // The daemon browses the landed folder beside its home: named in its roots file, written after the move.
    // The workspace's own project and the folder just landed, both browsable; the record names one project and
    // an import beside it adds no second one to it.
    const own = (await rt.workspaces.get(ws.id)).project.path;
    const browsable = machine.execLog.filter(c => c.includes("/root/.wsp/roots")).at(-1)!;
    expect(browsable).toBe(`mkdir -p '/root/.wsp'\nprintf '%s\\n' '${own}' '/root/work/proj' > '/root/.wsp/roots.next'\nmv -f '/root/.wsp/roots.next' '/root/.wsp/roots'`);
    expect(machine.execLog.indexOf(browsable)).toBeGreaterThan(machine.execLog.indexOf(landing));
  });

  it("fails the import when the machine will not take the roots file, and the workspace's own project stands", async () => {
    const backend = stubBackend();
    const plain = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd.includes("/root/.wsp/roots") ? { exitCode: 1, stdout: "", stderr: "mkdir: read-only file system" } : plain(m, cmd));
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    await expect(rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/work/proj", bundler: fakeBundler() })).rejects.toThrow(
      "could not make /root/work/proj browsable on the machine: mkdir: read-only file system",
    );
    expect(imports(events).at(-1)).toMatchObject({ stage: "failed", message: "could not make /root/work/proj browsable on the machine: mkdir: read-only file system" });
    expect((await rt.workspaces.get(ws.id)).project.path).toMatch(/^\/root\/stub-/);
  });

  it("a rewrite the person accepted reaches the pack, is said in the consented line and named in the result", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const bundler = fakeBundler([GIT_CONFIG]);
    const result = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/proj", carry: [".env"], rewrite: [".git/config"], bundler });
    expect(bundler.calls).toEqual(["plan", "pack .env rewrite .git/config"]);
    expect(result).toEqual({ dest: "/root/proj", files: 4, bytes: 4000, parts: 1, cut: ["config/secrets.json", "keys/id_ed25519"], rewritten: [".git/config"], agents: [], project: { name: "proj", dest: "/root/proj", importedAt: expect.any(String), size: 4000 } });
    const stages = imports(events);
    expect(stages[0]!.message).toBe("6 files, 4 KB and the repository; 4 secret-shaped files; 2 caches left behind.");
    expect(stages[1]!.message).toBe("Carrying .env; rewriting .git/config to https://github.com/example/proj.git; cut config/secrets.json, keys/id_ed25519.");
    events.length = 0;
    await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/other", rewrite: [".git/config"], bundler: fakeBundler([AUTH_CONFIG]) });
    expect(imports(events)[1]!.message).toBe("Rewriting .git/config to https://github.com/example/proj.git without http.extraheader; cut .env, config/secrets.json, keys/id_ed25519.");
    events.length = 0;
    await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/third", rewrite: [".git/config"], bundler: fakeBundler([{ ...AUTH_CONFIG, rewrite: { urls: [], drop: ["http.extraheader"] } }]) });
    expect(imports(events)[1]!.message).toBe("Rewriting .git/config without http.extraheader; cut .env, config/secrets.json, keys/id_ed25519.");
  });

  it("an existing path is refused with kind exists before any byte goes up, and replaced when asked", async () => {
    const backend = stubBackend();
    const base = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd.startsWith("test -e ") ? { exitCode: 0, stdout: "yes\n", stderr: "" } : base(m, cmd));
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const before = backend.puts.length;
    await expect(rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/proj", bundler: fakeBundler() })).rejects.toMatchObject({ kind: "exists" });
    expect(backend.puts).toHaveLength(before);
    const first = imports(events);
    expect(first.map(e => e.stage)).toEqual(["planned", "consented", "packing", "uploading", "failed"]);
    expect(first[1]!.message).toBe("No secret-shaped file travels; cut .env, config/secrets.json, keys/id_ed25519.");
    expect(first[4]!.message).toBe("/root/proj already exists on the machine; import with replace to overwrite it");
    events.length = 0;
    const result = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/proj", replace: true, bundler: fakeBundler() });
    expect(result.dest).toBe("/root/proj");
    expect(backend.puts).toHaveLength(before + 1);
    expect(imports(events).map(e => e.stage)).toEqual(["planned", "consented", "packing", "uploading", "uploading", "landing", "done"]);
    const landing = backend.machines[0]!.runLog.find(s => s.includes("mv "))!;
    expect(landing).toContain("rm -rf '/root/proj'\nmv ");
    expect(landing).not.toContain("exit 66");
  });

  it("the agents named travel: their state is packed with the machine's presence per agent, lands as an overlay on the guest's root after the project, the merges run there, and the result says what became of each; an agent not named is never read", async () => {
    const backend = stubBackend();
    const base = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd.includes('echo "missing') ? { exitCode: 0, stdout: "missing pi\n", stderr: "" } : cmd.startsWith("python3 ") ? { exitCode: 0, stdout: 'rewrote 2 rollouts\n{"merged": 3, "kept": 0}\n', stderr: "" } : base(m, cmd));
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const before = backend.puts.length;
    const bundler = fakeBundler([], AGENTS);
    const result = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/work/proj", carry: [".env"], agents: ["claude", "pi", "codex"], bundler });
    expect(bundler.calls).toEqual(["plan", "pack .env", "state claude+,pi-,codex+ to /root/work/proj"]);
    expect(result.agents).toEqual([
      { agent: "claude", files: 1, bytes: Buffer.byteLength("claude at /root/work/proj\n"), outcome: "moved" },
      { agent: "pi", files: 1, bytes: Buffer.byteLength(`pi at ${SOURCE}\n`), outcome: "carried" },
      { agent: "codex", files: 1, bytes: Buffer.byteLength("codex at /root/work/proj\n"), outcome: "moved", rows: 3 },
    ]);
    const probe = backend.machines[0]!.execLog.find(c => c.includes('echo "missing'))!;
    expect(probe).toContain("for b in 'claude' 'codex' 'pi'; do command -v");
    expect(probe).not.toContain("gemini");
    const stages = imports(events);
    expect(stages.map(e => e.stage)).toEqual(["planned", "consented", "packing", "uploading", "uploading", "landing", "uploading", "uploading", "landing", "landing", "done"]);
    expect(stages[1]!.message).toBe("Carrying .env; cut config/secrets.json, keys/id_ed25519. Sessions travel for Claude Code (2 sessions), Pi (1 session), Codex (3 sessions).");
    expect(stages[6]!.message).toMatch(/^Uploading 3 session files and the rows to merge, /);
    expect(stages[8]!.message).toBe("Merging rows into Codex.");
    const said = "Claude Code moved, Pi carried unchanged since it is not on the machine, Codex moved, 3 rows merged";
    expect(stages[9]!.message).toBe(`Landing sessions: ${said}.`);
    expect(stages[10]!.message).toBe(`4 files, 4 KB, landed at /root/work/proj; sessions: ${said}.`);
    expect(backend.puts).toHaveLength(before + 2);
    const out = extract(backend.puts[before + 1]!.body);
    expect(readFileSync(join(out, "root/.claude-cfg/sessions/claude.jsonl"), "utf8")).toBe("claude at /root/work/proj\n");
    expect(readFileSync(join(out, "root/.pi/agent/sessions/pi.jsonl"), "utf8")).toBe(`pi at ${SOURCE}\n`);
    expect(readFileSync(join(out, "root/.codex/sessions/codex.jsonl"), "utf8")).toBe("codex at /root/work/proj\n");
    expect(readFileSync(join(out, "tmp/wsp-merge-0000/codex.py"), "utf8")).toBe("print()\n");
    const machine = backend.machines[0]!;
    // The create landed the machine context by the same road; the import's two archives are the last two.
    const untars = machine.runLog.filter(s => s.includes("tar xzf")).slice(-2);
    expect(untars[0]).toMatch(/tar xzf - -C '\/root\/work\/proj\.wsp-in-[^']+' --no-same-owner/);
    expect(untars[1]).toMatch(/tar xzf - -C '\/' --no-same-owner/);
    expect(machine.runLog.findIndex(s => s.includes("mv "))).toBeLessThan(machine.runLog.indexOf(untars[1]!));
    // The merge runs after the overlay has landed, as a run with a deadline, and the script is taken away by the next exec.
    const merge = machine.runLog.indexOf(mergeCommand("codex"));
    expect(merge).toBeGreaterThan(machine.runLog.indexOf(untars[1]!));
    expect(machine.runOptions[merge]!.deadlineMs).toBe(120_000);
    expect(machine.runLog.filter(s => s.startsWith("python3 "))).toEqual([mergeCommand("codex")]);
    expect(machine.execLog[machine.execLog.indexOf(mergeCommand("codex")) + 1]).toBe(removeCommand("codex"));
  });

  it("a merge the deadline killed still has its script removed and fails by its exit; a merge that kept the machine's own row carries the note into the done line", async () => {
    const backend = stubBackend();
    const base = backend.execImpl;
    backend.execImpl = (m, cmd) =>
      cmd.startsWith(`python3 '${MERGE_DIR}/codex.py'`)
        ? { exitCode: 124, stdout: "", stderr: "" }
        : cmd.startsWith(`python3 '${MERGE_DIR}/hermes.py'`)
          ? { exitCode: 0, stdout: '{"merged": 1, "kept": 1, "note": "the machine already lists /root/work/proj as proj"}\n', stderr: "" }
          : base(m, cmd);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const result = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/work/proj", agents: ["codex", "hermes"], bundler: fakeBundler([], [...AGENTS, HERMES]) });
    expect(result.agents).toEqual([
      { agent: "codex", files: 1, bytes: Buffer.byteLength("codex at /root/work/proj\n"), outcome: "failed", error: "the merge on the machine failed (exit 124): no output" },
      { agent: "hermes", files: 0, bytes: 0, outcome: "moved", rows: 1, note: "the machine already lists /root/work/proj as proj" },
    ]);
    const log = backend.machines[0]!.execLog;
    for (const agent of ["codex", "hermes"]) expect(log[log.indexOf(mergeCommand(agent)) + 1], agent).toBe(removeCommand(agent));
    const said = "Codex failed: the merge on the machine failed (exit 124): no output, Hermes Agent moved, 1 row merged (the machine already lists /root/work/proj as proj)";
    expect(imports(events).at(-1)!.message).toBe(`3 files, 4 KB, landed at /root/work/proj; sessions: ${said}.`);
  });

  it("a merge the machine cannot take yet leaves the rows waiting with the reason, one that fails says why, and rows alone still travel", async () => {
    const backend = stubBackend();
    const base = backend.execImpl;
    backend.execImpl = (m, cmd) =>
      cmd.startsWith(`python3 '${MERGE_DIR}/codex.py'`)
        ? { exitCode: 0, stdout: '{"waiting": "no /root/.codex/state_5.sqlite on the machine"}\n', stderr: "" }
        : cmd.startsWith(`python3 '${MERGE_DIR}/hermes.py'`)
          ? { exitCode: 127, stdout: "", stderr: "bash: line 1: python3: command not found\n" }
          : base(m, cmd);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const before = backend.puts.length;
    const result = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/work/proj", agents: ["codex", "hermes"], bundler: fakeBundler([], [...AGENTS, HERMES]) });
    expect(result.agents).toEqual([
      { agent: "codex", files: 1, bytes: Buffer.byteLength("codex at /root/work/proj\n"), outcome: "transcript-only", note: "no /root/.codex/state_5.sqlite on the machine" },
      { agent: "hermes", files: 0, bytes: 0, outcome: "failed", error: "the merge on the machine failed (exit 127): bash: line 1: python3: command not found" },
    ]);
    const said = "Codex transcripts landed but not yet in its session list (no /root/.codex/state_5.sqlite on the machine), Hermes Agent failed: the merge on the machine failed (exit 127): bash: line 1: python3: command not found";
    expect(imports(events).at(-1)!.message).toBe(`3 files, 4 KB, landed at /root/work/proj; sessions: ${said}.`);
    expect(backend.machines[0]!.runLog.filter(s => s.startsWith("python3 "))).toEqual([mergeCommand("codex"), mergeCommand("hermes")]);
    events.length = 0;
    backend.execImpl = (m, cmd) => (cmd.startsWith("python3 ") ? { exitCode: 0, stdout: '{"merged": 0, "kept": 1}\n', stderr: "" } : base(m, cmd));
    const again = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/work/other", agents: ["hermes"], bundler: fakeBundler([], [HERMES]) });
    expect(again.agents).toEqual([{ agent: "hermes", files: 0, bytes: 0, outcome: "moved", rows: 0 }]);
    expect(backend.puts).toHaveLength(before + 4);
    const stages = imports(events);
    expect(stages.map(e => e.stage)).toEqual(["planned", "consented", "packing", "uploading", "uploading", "landing", "uploading", "uploading", "landing", "landing", "done"]);
    expect(stages[6]!.message).toMatch(/^Uploading the rows to merge, /);
    expect(stages[10]!.message).toBe("3 files, 4 KB, landed at /root/work/other; sessions: Hermes Agent moved, its rows already there.");
  });

  it("an agent the plan could not read never travels, even when named, and the consented line says why", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const unreadable: ProjectAgent = { agent: "opencode", name: "OpenCode", sessions: 0, bytes: 0, carry: "transcript-only", error: "file is not a database" };
    const bundler = fakeBundler([], [...AGENTS, unreadable]);
    const result = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/proj", agents: ["claude", "opencode"], bundler });
    expect(bundler.calls).toEqual(["plan", "pack ", "state claude+ to /root/proj"]);
    expect(result.agents.map(a => a.agent)).toEqual(["claude"]);
    expect(imports(events)[1]!.message).toBe("No secret-shaped file travels; cut .env, config/secrets.json, keys/id_ed25519. Sessions travel for Claude Code (2 sessions); Pi, Codex stay; OpenCode could not be read (file is not a database).");
  });

  it("with no agent named nothing about them is read and the consented line says so", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const before = backend.puts.length;
    const bundler = fakeBundler([], AGENTS);
    const result = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/proj", bundler });
    expect(bundler.calls).toEqual(["plan", "pack "]);
    expect(result.agents).toEqual([]);
    expect(backend.puts).toHaveLength(before + 1);
    expect(backend.machines[0]!.execLog.some(c => c.includes('echo "missing'))).toBe(false);
    expect(imports(events)[1]!.message).toBe("No secret-shaped file travels; cut .env, config/secrets.json, keys/id_ed25519. No agent sessions travel.");
  });

  it("a napping workspace and an unknown one are refused before the folder is read", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    await rt.workspaces.nap(ws.id);
    const bundler = fakeBundler();
    await expect(rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/proj", bundler })).rejects.toThrow(/^Workspace is paused; wake it to import$/);
    await expect(rt.projects.import({ workspaceId: "ws_nope", source: SOURCE, dest: "/root/proj", bundler })).rejects.toThrow(/no such workspace/);
    expect(bundler.calls).toEqual([]);
  });

  it("over the wire the host's folder browser answers host.folders with the level asked for, wide only for this computer's own window; a server without one refuses it", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const asked: { dir?: string; hidden?: boolean; repos?: boolean; wide?: boolean }[] = [];
    const listing: HostFolderListing = { dir: SOURCE, roots: ["/Users/dev", "/Volumes/work/api"], folders: [{ path: `${SOURCE}/spoo`, repo: true }], hidden: 3 };
    srv = await serveRuntime(rt, {
      port: 0,
      authToken: "t",
      folders: {
        list: async req => {
          asked.push(req);
          return listing;
        },
      },
    });
    expect(await wsRequest(srv.port, "t", { op: "host.folders", dir: SOURCE, hidden: true })).toMatchObject({ ok: true, listing });
    expect(await wsRequest(srv.port, "t", { op: "host.folders" })).toMatchObject({ ok: true, listing });
    expect(await wsRequest(srv.port, "t", { op: "host.folders", repos: true, origin: "here" })).toMatchObject({ ok: true, listing });
    expect(asked).toEqual([{ dir: SOURCE, hidden: true, wide: false }, { wide: false }, { repos: true, wide: true }]);
    await srv.close();
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "host.folders" })).toMatchObject({ ok: false, error: "this runtime cannot browse the folders on this computer" });
  });

  it("over the wire the host's bundler answers project.plan and feeds project.import; a server without one refuses both", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const sources: string[] = [];
    srv = await serveRuntime(rt, {
      port: 0,
      authToken: "t",
      projects: source => {
        sources.push(source);
        return fakeBundler([GIT_CONFIG], AGENTS);
      },
    });
    const planned = await wsRequest(srv.port, "t", { op: "project.plan", source: SOURCE });
    expect(planned["ok"]).toBe(true);
    expect((planned["plan"] as ProjectPlan).secrets).toEqual(expect.arrayContaining([GIT_CONFIG]));
    expect((planned["plan"] as ProjectPlan).secrets.map(s => s.path)).toEqual([".env", ".git/config", "config/secrets.json", "keys/id_ed25519"]);
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const imported = await wsRequest(srv.port, "t", { op: "project.import", workspaceId: ws.id, source: SOURCE, dest: "/root/proj", carry: ["keys/id_ed25519"], rewrite: [".git/config"], agents: ["pi"] });
    expect(imported["ok"]).toBe(true);
    expect(imported["imported"]).toEqual({ dest: "/root/proj", files: 4, bytes: 4000, parts: 1, cut: [".env", "config/secrets.json"], rewritten: [".git/config"], agents: [{ agent: "pi", files: 1, bytes: Buffer.byteLength("pi at /root/proj\n"), outcome: "moved" }], project: { name: "proj", dest: "/root/proj", importedAt: expect.any(String), size: 4000 } });
    expect(sources).toEqual([SOURCE, SOURCE]);
    await srv.close();
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    const refused = await wsRequest(srv.port, "t", { op: "project.plan", source: SOURCE });
    expect(refused).toMatchObject({ ok: false, error: "this runtime cannot read folders on this computer" });
    expect(await wsRequest(srv.port, "t", { op: "project.import", workspaceId: ws.id, source: SOURCE, dest: "/root/other" })).toMatchObject({ ok: false, error: "this runtime cannot read folders on this computer" });
  });
});
