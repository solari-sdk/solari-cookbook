// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { guestAgentHomes, stateListing, tarOf, type UnreadStore } from "@wsp/engine";
import { storeUnreadLine, type EventUnion, type ProjectExportEvent } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type LandRequest, type LandedProject, type ProjectLander } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, type StubBackend, createOn, projectOn } from "./stub-backend.js";
import { wsRequest } from "./ws-client.js";

let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const SOURCE = "/root/work/proj";
const DEST = "/Users/dev/code/proj";
const FOLDER_TGZ = tarOf([{ path: "./src/index.ts", mode: 0o644, content: "export const a = 1;\n" }]);
const STATE_TGZ = tarOf([{ path: "root/.claude-cfg/projects/-root-work-proj/S1.jsonl", mode: 0o644, content: `{"cwd":"${SOURCE}"}\n` }]);
const EXCLUDED = "node_modules\ndist\n";
/** What the modules' listings print on a machine holding this project and another: the project's own keyed directory
 * and rollout; never the other project's directory beside them. */
const LISTED = ["/root/.claude-cfg/projects/-root-work-proj", "/root/.codex/sessions/2026/09/06/rollout-t1.jsonl"];
/** The stores the agents keep for every project, whose filtered copies the listing writes under its scratch root
 * and names in the stores' place, each at the path it mirrors. */
const COPIED = ["/root/.codex/state_5.sqlite", "/root/.hermes/state.db"];

/** The scratch root the listing command tells the machine to write those copies under, off the values it carries. */
function copyRoot(command: string): string {
  for (const [, b64] of command.matchAll(/data\("([A-Za-z0-9+/=]+)"\)/g)) {
    const value = JSON.parse(Buffer.from(b64!, "base64").toString("utf8")) as unknown;
    const at = typeof value === "string" ? /^\/tmp\/wsp-state-[^/]+/.exec(value) : null;
    if (at !== null) return at[0];
  }
  throw new Error("the listing named no scratch root");
}
/** A store an agent keeps for every project that the machine could not read, on the marked line a module's listing
 * prints it on: nothing of that home follows it. */
const unreadLine = (u: UnreadStore): string => `!unread ${Buffer.from(JSON.stringify(u), "utf8").toString("base64")}`;
/** The path the export removed from the machine once the archive was down. */
const removed = (execLog: readonly string[]): string => /^rm -rf '([^']+)'$/.exec(execLog.find(c => c.startsWith("rm -rf '/tmp/wsp-state-")) ?? "")?.[1] ?? "";

/** The catalog names the real lander puts on its report rows. */
const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes Agent" };

/** What the host would do on this computer: remember the probe, the landing and the archives as they were on disk
 * when it was asked to land them, answer with a small result. */
function fakeLander(existing?: number): ProjectLander & { probes: string[]; landings: LandRequest[]; seen: { archive: Buffer; state?: Buffer }[] } {
  const probes: string[] = [];
  const landings: LandRequest[] = [];
  const seen: { archive: Buffer; state?: Buffer }[] = [];
  return {
    probes,
    landings,
    seen,
    caches: { dirs: ["node_modules", "dist"], files: [], markers: ["pyvenv.cfg"] },
    probe: async dest => {
      probes.push(dest);
      return existing === undefined ? undefined : { files: existing };
    },
    land: async (req): Promise<LandedProject> => {
      landings.push(req);
      seen.push({ archive: readFileSync(req.archive), ...(req.state !== undefined ? { state: readFileSync(req.state.archive) } : {}) });
      const unread = (req.unread ?? []).map(u => ({ agent: u.agent, name: NAMES[u.agent] ?? u.agent, files: 0, bytes: 0, outcome: "failed" as const, error: storeUnreadLine(u.store, u.why) }));
      const agents = req.state === undefined ? [] : [
        { agent: "claude", name: "Claude Code", files: 3, bytes: 300, outcome: "moved" as const, sessions: 2 },
        { agent: "codex", name: "Codex", files: 1, bytes: 100, outcome: "transcript-only" as const, sessions: 2, skipped: 1 },
        { agent: "hermes", name: "Hermes Agent", files: 0, bytes: 0, outcome: "nothing" as const, sessions: 1 },
      ];
      const named = req.state?.agents === undefined ? agents : agents.filter(a => req.state!.agents!.includes(a.agent));
      return { files: 3, bytes: 4000, agents: [...named, ...unread] };
    },
  };
}

/** The machine: the folder is there, the archives it packs are served for download, and the modules' listings print
 * the paths given plus a copy under the scratch root for each store named. */
function machineWith(backend: StubBackend, present: readonly string[], copies: readonly string[] = [], unread: readonly UnreadStore[] = []): void {
  const base = backend.execImpl;
  const tars = new Map<string, Buffer>();
  backend.downloads = path => tars.get(path) ?? gzipSync(Buffer.alloc(1024));
  backend.execImpl = (m, cmd) => {
    if (cmd.startsWith("test -d ")) return { exitCode: 0, stdout: "yes\n", stderr: "" };
    if (cmd.startsWith("set -e\npython3 -c ")) {
      const wrote = copies.length === 0 ? [] : copies.map(store => `${copyRoot(cmd)}${store}`);
      return { exitCode: 0, stdout: [...present, ...wrote, ...unread.map(unreadLine)].map(l => `${l}\n`).join(""), stderr: "" };
    }
    const out = /tar czf '([^']+)'/.exec(cmd)?.[1];
    if (out !== undefined && cmd.includes("find '.'")) {
      tars.set(out, FOLDER_TGZ);
      return { exitCode: 0, stdout: EXCLUDED, stderr: "" };
    }
    if (out !== undefined) {
      tars.set(out, STATE_TGZ);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const sized = /^wc -c < '([^']+)'/.exec(cmd)?.[1];
    if (sized !== undefined) return { exitCode: 0, stdout: `${tars.get(sized)?.length ?? 0}\n`, stderr: "" };
    return base(m, cmd);
  };
}

const exports = (events: EventUnion[]): ProjectExportEvent[] => events.filter((e): e is ProjectExportEvent => e.type === "project.export");

describe("project.export on a workspace", () => {
  it("packs the folder on the machine under the lander's cache rule, brings it and only the paths the modules' listings name home, lands both as files through the lander and reports each stage and every agent", async () => {
    const backend = stubBackend();
    machineWith(backend, LISTED, COPIED);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const lander = fakeLander();
    const result = await rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, lander });
    expect(result).toEqual({
      dest: DEST,
      files: 3,
      bytes: 4000,
      excluded: ["dist", "node_modules"],
      agents: [
        { agent: "claude", files: 3, bytes: 300, outcome: "moved", sessions: 2 },
        { agent: "codex", files: 1, bytes: 100, outcome: "transcript-only", sessions: 2, skipped: 1 },
        { agent: "hermes", files: 0, bytes: 0, outcome: "nothing", sessions: 1 },
      ],
    });
    expect(lander.probes).toEqual([DEST]);
    expect(lander.landings).toHaveLength(1);
    const landing = lander.landings[0]!;
    expect(landing).toMatchObject({ source: SOURCE, dest: DEST, replace: false });
    expect(lander.seen[0]!.archive.equals(FOLDER_TGZ)).toBe(true);
    expect(lander.seen[0]!.state?.equals(STATE_TGZ)).toBe(true);
    expect(landing.state?.homes).toEqual(guestAgentHomes());
    expect(landing.state?.agents).toBeUndefined();
    const stages = exports(events);
    expect(stages.map(e => e.stage)).toEqual(["packing", "downloading", "downloading", "packing", "downloading", "downloading", "landing", "done"]);
    expect(stages[0]!.message).toBe(`Packing ${SOURCE} on the machine.`);
    expect(stages[1]).toMatchObject({ message: `The folder: 0 B of ${FOLDER_TGZ.length} B.`, bytes: 0, total: FOLDER_TGZ.length });
    expect(stages[2]).toMatchObject({ bytes: FOLDER_TGZ.length, total: FOLDER_TGZ.length });
    expect(stages[3]!.message).toBe("Packing the agents' state for it on the machine.");
    expect(stages[4]!.message).toMatch(/^Agent state: 0 B of /);
    expect(stages[6]!.message).toBe(`Landing at ${DEST}.`);
    expect(stages[7]!.message).toBe(`3 files, 4 KB, landed at ${DEST}; 2 caches left behind; sessions: Claude Code (2 sessions) moved, Codex (2 sessions) transcripts landed but not yet in its session list here, 1 indexed rollout not under sessions/ skipped, Hermes Agent (1 session) had nothing to bring.`);
    for (const e of stages) expect(e).toMatchObject({ workspaceId: ws.id, source: SOURCE, dest: DEST, elapsedMs: expect.any(Number) });
    const machine = backend.machines[0]!;
    expect(machine.execLog.some(c => c === `test -d '${SOURCE}' && echo yes || echo no`)).toBe(true);
    const pack = machine.runLog.find(s => s.includes("find '.'"))!;
    expect(pack).toContain(`cd '${SOURCE}'`);
    expect(pack).toContain("\\( -type d \\( -name 'node_modules' -o -name 'dist' \\) \\) -o \\( -type d -exec test -f '{}/pyvenv.cfg' \\; \\)");
    expect(pack).toMatch(/tar czf '\/tmp\/wsp-out-[^']+\.tgz' --no-recursion --null -T '\/tmp\/wsp-out-[^']+\.tgz\.keep'$/m);
    const listing = machine.runLog.find(c => c.startsWith("set -e\npython3 -c "))!;
    const root = copyRoot(listing);
    expect(listing).toBe(stateListing(guestAgentHomes(), SOURCE, root));
    // The copies travel from the scratch root that mirrors the homes, so each lands in the archive at its store's path.
    const state = machine.runLog.find(s => s.startsWith("tar czf") && s.includes("-C '/'"))!;
    expect(state).toBe(`tar czf ${/tar czf ('[^']+')/.exec(state)![1]} -C '/' ${LISTED.map(p => `'${p.slice(1)}'`).join(" ")} -C '${root}' ${COPIED.map(p => `'${p.slice(1)}'`).join(" ")}`);
    expect(machine.execLog.filter(c => c.startsWith("rm -f '/tmp/wsp-"))).toHaveLength(2);
    expect(removed(machine.execLog)).toBe(root);
    expect(existsSync(landing.archive)).toBe(false);
    expect(existsSync(landing.state!.archive)).toBe(false);
    expect(existsSync(dirname(landing.archive))).toBe(false);
  });

  it("a store the machine cannot read brings nothing from that home: it is not in the archive, the export's own line says which store and why, and the landing report carries the same sentence", async () => {
    const backend = stubBackend();
    const unread: UnreadStore = { agent: "hermes", store: "/root/.hermes/state.db", why: "file is not a database" };
    machineWith(backend, LISTED, ["/root/.codex/state_5.sqlite"], [unread]);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const lander = fakeLander();
    const result = await rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, lander });
    const sentence = storeUnreadLine(unread.store, unread.why);
    expect(sentence).toBe("could not read /root/.hermes/state.db on the machine, so nothing from it travelled: file is not a database");
    expect(lander.landings[0]!.unread).toEqual([unread]);
    expect(result.agents.at(-1)).toEqual({ agent: "hermes", files: 0, bytes: 0, outcome: "failed", error: sentence });
    expect(exports(events).at(-1)!.message).toContain(`Hermes Agent failed: ${sentence}`);
    // Neither the store nor the home beside it reaches the archive, so no other project's rows leave the machine.
    const state = backend.machines[0]!.runLog.find(s => s.startsWith("tar czf") && s.includes("-C '/'"))!;
    expect(state).not.toContain(".hermes");
  });

  it("an existing destination is refused with kind exists before anything is asked of the machine, and replaced when asked", async () => {
    const backend = stubBackend();
    machineWith(backend, []);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const commands = backend.machines[0]!.execLog.length;
    const lander = fakeLander(12);
    await expect(rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, lander })).rejects.toMatchObject({ kind: "exists", message: `${DEST} already exists on this computer with 12 files; export with replace to overwrite it` });
    expect(backend.machines[0]!.execLog).toHaveLength(commands);
    expect(lander.landings).toEqual([]);
    expect(exports(events).map(e => [e.stage, e.message])).toEqual([["failed", `${DEST} already exists on this computer with 12 files; export with replace to overwrite it`]]);
    events.length = 0;
    const result = await rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, replace: true, lander });
    expect(lander.landings[0]).toMatchObject({ replace: true });
    expect(lander.landings[0]!.state).toBeUndefined();
    expect(result.agents).toEqual([]);
    expect(exports(events).map(e => e.stage)).toEqual(["packing", "downloading", "downloading", "landing", "done"]);
    expect(exports(events).at(-1)!.message).toBe(`3 files, 4 KB, landed at ${DEST}; 2 caches left behind; no agent sessions for it on the machine.`);
    // A listing that named nothing still leaves the machine without the scratch root it was given.
    expect(removed(backend.machines[0]!.execLog)).toMatch(/^\/tmp\/wsp-state-/);
  });

  it("agents named narrow the roots looked for on the machine and reach the lander", async () => {
    const backend = stubBackend();
    machineWith(backend, ["/root/.claude-cfg/projects/-root-work-proj"]);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const lander = fakeLander();
    const result = await rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, agents: ["claude", "pi"], lander });
    const machine = backend.machines[0]!;
    const listing = machine.runLog.find(c => c.startsWith("set -e\npython3 -c "))!;
    expect(listing).toBe(stateListing(guestAgentHomes(), SOURCE, removed(machine.execLog), ["claude", "pi"]));
    expect(listing.split("\npython3 -c '")).toHaveLength(3);
    expect(lander.landings[0]!.state?.agents).toEqual(["claude", "pi"]);
    expect(result.agents.map(a => a.agent)).toEqual(["claude"]);
  });

  it("a folder that is not on the machine, a napping workspace and an unknown one are refused, the lander never asked to land", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const lander = fakeLander();
    await expect(rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, lander })).rejects.toThrow(`${SOURCE} is not a folder on the machine`);
    await rt.workspaces.nap(ws.id);
    await expect(rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, lander })).rejects.toThrow(/^Workspace is paused; wake it to export$/);
    await expect(rt.projects.export({ workspaceId: "ws_nope", source: SOURCE, dest: DEST, lander })).rejects.toThrow(/no such workspace/);
    expect(lander.landings).toEqual([]);
    expect(lander.probes).toEqual([DEST]);
  });

  it("over the wire the host's lander answers project.export; a server without one refuses it", async () => {
    const backend = stubBackend();
    machineWith(backend, []);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const lander = fakeLander();
    srv = await serveRuntime(rt, { port: 0, authToken: "t", landing: lander });
    const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
    const exported = await wsRequest(srv.port, "t", { op: "project.export", workspaceId: ws.id, source: SOURCE, dest: DEST, agents: ["claude"] });
    expect(exported).toMatchObject({ ok: true, exported: { dest: DEST, files: 3, bytes: 4000, excluded: ["dist", "node_modules"], agents: [] } });
    expect(lander.landings[0]).toMatchObject({ source: SOURCE, dest: DEST, replace: false });
    await srv.close();
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "project.export", workspaceId: ws.id, source: SOURCE, dest: DEST })).toMatchObject({ ok: false, error: "this runtime cannot write folders on this computer" });
    const refused = await wsRequest(srv.port, "t", { op: "project.export", workspaceId: ws.id, source: SOURCE, dest: DEST, replace: false });
    expect(refused["ok"]).toBe(false);
  });
});
