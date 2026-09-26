// SPDX-License-Identifier: AGPL-3.0-only
// A workspace with its project loaded is snapshotted as a project golden, and forks of that snapshot start with the
// project in place: the record the snapshot keeps, the refusals, what a fork inherits, and the two ops over the wire.
import { gunzipSync } from "node:zlib";
import { DISK_SYNC_CMD, DiskSyncError, MachineUnreachableError, machineAnswer, tarOf } from "@wsp/engine";
import { DEVICE_OPS, THREAD_OPS, diskSyncFailedLine, machineUnreachableLine, noProjectImageLine, projectImageInUseRefusal, type GoldenManifest, type ProjectGolden, type ProjectPlan } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyKey, createRuntime, type PackedProject, type ProjectBundler, type Runtime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, type StubBackend, createOn, projectOn } from "./stub-backend.js";
import { WsClient } from "./ws-client.js";
import { until } from "./until.js";

let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const SOURCE = "/Users/dev/code/proj";
const DEST = "/root/work/proj";
const T0 = Date.parse("2026-09-06T10:00:00.000Z");
/** templateHost() takes the part after the last colon, so every name this host writes carries the mark "h1". */
const HOST = "box:h1";

/** The golden the workspaces stand on: one sealed desktop version at head, sized above the provider default. */
const MANIFEST: GoldenManifest = {
  head: 12,
  versions: [
    { version: 12, snapshotId: "snap_golden-v12", kind: "desktop", baseTemplate: "base", setupSha: "abc", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 }, size: { cpu: 4, memMb: 8192 } },
  ],
};

/** A folder of one file, nothing secret-shaped, no agents. */
function bundler(): ProjectBundler {
  const plan: ProjectPlan = { source: SOURCE, repo: true, files: 1, bytes: 20, secrets: [], excluded: [], skipped: [], agents: [] };
  return {
    plan: async () => plan,
    pack: async (): Promise<PackedProject> => ({ tar: tarOf([{ path: "src/index.ts", mode: 0o644, content: "export const a = 1;\n" }]), files: 1, bytes: 20, cut: [], rewritten: [] }),
    packState: async () => {
      throw new Error("no agent state in this test");
    },
  };
}

/** The read-back window a snapshot's delete polls the listing under, short enough for a test to run it out. */
const QUICK = { graceMs: 40, pollMs: 1 };

async function setup(store: Store = memoryStore()): Promise<{ rt: Runtime; backend: StubBackend; store: Store; advance: (ms: number) => void }> {
  const backend = stubBackend();
  await store.put("goldens", copyKey("default", "default"), MANIFEST);
  const { clock, advance } = fakeClock(T0);
  const rt = createRuntime({ backend, store, adapters: {}, clock, hostId: HOST, killConfirm: QUICK });
  return { rt, backend, store, advance };
}

/** A workspace of the project, forked from the golden's head: the project is what a workspace is made for, so it
 * is in place from the create and the snapshot is named after it. */
async function loaded(rt: Runtime, advance: (ms: number) => void, name = "task", project?: string) {
  const id = project ?? (await projectOn(rt, "default", "https://github.com/dev/proj.git")).id;
  const ws = await rt.workspaces.create({ project: id, golden: "snap_golden-v12", name });
  advance(60_000);
  return ws;
}

/** What a snapshot lists: the workspace's own project, at the path a copy holds it, stamped when the workspace was made. */
const PROJECT = { name: "proj", dest: "/root/proj", importedAt: "2026-09-06T10:00:00.000Z" };

describe("a project golden", () => {
  it("a workspace carries the project it was made for, and the record outlives the process", async () => {
    const { rt, advance, store, backend } = await setup();
    const ws = await loaded(rt, advance);
    expect(ws.project).toMatchObject({ name: "proj", path: "/root/proj", computer: "default" });
    expect((await rt.workspaces.list())[0]!.project.id).toBe(ws.project.id);
    const again = createRuntime({ backend, store, adapters: {}, hostId: HOST });
    expect((await again.workspaces.get(ws.id)).project).toEqual(ws.project);
  });

  it("snapshot takes the disk under the project's name, keeps the record with the golden version, the project and the workspace, and leaves the machine first-life", async () => {
    const { rt, advance, store, backend } = await setup();
    const ws = await loaded(rt, advance);
    advance(5 * 60_000);
    const golden = await rt.workspaces.snapshot(ws.id);
    const expected: ProjectGolden = {
      snapshotId: "snap_wsp-h1-project-proj-2026-09-06T10-06-00-000Z",
      projects: [PROJECT],
      golden: "snap_golden-v12",
      version: 12,
      workspaceId: ws.id,
      workspaceName: "task",
      createdAt: "2026-09-06T10:06:00.000Z",
    };
    expect(golden).toEqual(expected);
    expect(backend.snapshots.map(s => s.id)).toEqual([expected.snapshotId]);
    expect(await store.get("project-goldens", expected.snapshotId)).toEqual(expected);
    expect(await rt.golden.projects()).toEqual([expected]);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ firstLife: true, golden: "snap_golden-v12" });
    advance(60_000);
    const second = await rt.workspaces.snapshot(ws.id);
    expect(second.snapshotId).toBe("snap_wsp-h1-project-proj-2026-09-06T10-07-00-000Z");
    // The mark is what tells a later doctor run this host took it, since a snapshot carries no provider metadata.
    expect(backend.snapshots.map(r => r.name)).toEqual(["wsp-h1-project-proj-2026-09-06T10-06-00-000Z", "wsp-h1-project-proj-2026-09-06T10-07-00-000Z"]);
    expect((await rt.golden.projects()).map(p => p.snapshotId)).toEqual([expected.snapshotId, second.snapshotId]);
  });

  it("snapshot syncs the machine's disk before the provider is asked for the copy", async () => {
    const { rt, advance, backend } = await setup();
    const ws = await loaded(rt, advance);
    const synced: boolean[] = [];
    backend.beforeSnapshot = m => {
      synced.push(m.execLog.includes(DISK_SYNC_CMD));
    };
    const before = backend.machines[0]!.execLog.length;
    await rt.workspaces.snapshot(ws.id);
    expect(synced).toEqual([true]);
    expect(backend.machines[0]!.execLog.slice(before).filter(c => c === DISK_SYNC_CMD)).toHaveLength(1);
  });

  it("a woken workspace on a provider whose snapshots copy the disk from any life is snapshotted: the backend saw firstLife false and nothing in the runtime refused", async () => {
    const { rt, advance, backend } = await setup();
    backend.capabilities.snapshotsAnyLife = true;
    const ws = await loaded(rt, advance);
    await rt.workspaces.nap(ws.id);
    await rt.workspaces.wake(ws.id);
    const golden = await rt.workspaces.snapshot(ws.id);
    expect(golden).toMatchObject({ workspaceId: ws.id, projects: [PROJECT] });
    expect(backend.machines[0]!.snapshotLives).toEqual([{ firstLife: false }]);
    expect(backend.snapshots.map(s => s.id)).toEqual([golden.snapshotId]);
  });

  it("a provider whose forks boot cold still snapshots: the gate reads whether the provider copies a machine's disk, not how a fork of that image comes up", async () => {
    const { rt, advance, backend } = await setup();
    // A container provider's shape: a commit of the filesystem from any life, and a fork that boots cold with the
    // agents started again.
    backend.capabilities.liveCloneForks = false;
    backend.capabilities.snapshotsAnyLife = true;
    const ws = await loaded(rt, advance);
    await rt.workspaces.nap(ws.id);
    await rt.workspaces.wake(ws.id);
    advance(5 * 60_000);
    const golden = await rt.workspaces.snapshot(ws.id);
    expect(golden).toMatchObject({ workspaceId: ws.id, workspaceName: "task", projects: [PROJECT] });
    expect(backend.snapshots.map(s => s.id)).toEqual([golden.snapshotId]);
    const fork = await rt.workspaces.create({ project: ws.project.id, golden: golden.snapshotId, name: "task-a" });
    expect(fork).toMatchObject({ golden: golden.snapshotId });
    expect(fork.project.name).toBe("proj");
  });

  it("a napping workspace and one that was ever resumed are refused in one sentence, and no snapshot is taken", async () => {
    const { rt, advance, backend } = await setup();
    const ws = await loaded(rt, advance);
    await rt.workspaces.nap(ws.id);
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toThrow("task is napping; only a running machine can be snapshotted");
    await rt.workspaces.wake(ws.id);
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toMatchObject({ kind: "notFirstLife", message: expect.stringMatching(/^snapshot \S+ refused: machine m\d+ is not first-life/) });
    await expect(rt.workspaces.snapshot("ws_nope")).rejects.toThrow("no such workspace");
    expect(backend.snapshots).toEqual([]);
    expect(await rt.golden.projects()).toEqual([]);
  });

  /** The provider refusing every snapshot the way Solari does, with no request id, and df under /root answering `df`. */
  function refusing(backend: StubBackend, df: { exitCode: number; stdout: string; stderr: string }): void {
    backend.beforeSnapshot = () => {
      throw Object.assign(new Error("Failed to snapshot sandbox"), { kind: "snapshotUnavailable", status: 502 });
    };
    const plain = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd.startsWith("df -Pk /root") ? df : plain(m, cmd));
  }
  const ANSWER = String.raw`502 Failed to snapshot sandbox \(no request id from the provider, at \S+\)`;

  it("a refused snapshot of a disk 97 percent full names the disk and the provider's answer, keeps the provider's kind and status, logs the line, and changes nothing", async () => {
    const { rt, advance, backend, store } = await setup();
    const ws = await loaded(rt, advance);
    refusing(backend, { exitCode: 0, stdout: "20342400 20971520\n", stderr: "" });
    const before = await store.get("workspaces", ws.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const said = new RegExp(`^task was not snapshotted: its disk is 97 percent full \\(19\\.4 of 20 GB\\) and the provider answered ${ANSWER}; free space on it or delete the workspace, then snapshot again$`);
    try {
      await expect(rt.workspaces.snapshot(ws.id)).rejects.toMatchObject({ kind: "snapshotUnavailable", status: 502, message: expect.stringMatching(said) });
      expect(warn.mock.calls.map(c => String(c[0]))).toContainEqual(expect.stringMatching(said));
    } finally {
      warn.mockRestore();
    }
    expect(await store.get("workspaces", ws.id)).toEqual(before);
    expect(before).toMatchObject({ firstLife: true });
    expect(backend.machines[0]!.execLog.filter(c => c.startsWith("df -Pk /root"))).toHaveLength(1);
    expect(backend.snapshots).toEqual([]);
    expect(await rt.golden.projects()).toEqual([]);
  });

  it("a refused snapshot of a disk 41 percent full says the disk is not the reason, one whose df fails says why, and one whose df answers no size says what it printed", async () => {
    const { rt, advance, backend } = await setup();
    const ws = await loaded(rt, advance);
    refusing(backend, { exitCode: 0, stdout: "8598400 20971520\n", stderr: "" });
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toMatchObject({
      kind: "snapshotUnavailable",
      status: 502,
      message: expect.stringMatching(new RegExp(`^task was not snapshotted: the provider answered ${ANSWER}; its disk is 41 percent full \\(8\\.2 of 20 GB\\), so the disk is not the reason$`)),
    });
    refusing(backend, { exitCode: 1, stdout: "", stderr: "df: /root: No such file or directory" });
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(`^task was not snapshotted: the provider answered ${ANSWER}; the disk could not be read \\(df failed: df: /root: No such file or directory\\)$`)),
    });
    refusing(backend, { exitCode: 0, stdout: "123 0\n", stderr: "" });
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(`^task was not snapshotted: the provider answered ${ANSWER}; the disk could not be read \\(df answered 123 0\\)$`)),
    });
    expect(backend.snapshots).toEqual([]);
  });

  it("a sync the machine fails refuses the snapshot in one sentence with its answer, takes nothing and changes nothing", async () => {
    const { rt, advance, backend, store } = await setup();
    const ws = await loaded(rt, advance);
    const plain = backend.execImpl;
    const res = { exitCode: 1, stdout: "", stderr: "sync: Input/output error" };
    backend.execImpl = (m, cmd) => (cmd === DISK_SYNC_CMD ? res : plain(m, cmd));
    const before = await store.get("workspaces", ws.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let err: unknown;
    try {
      err = await rt.workspaces.snapshot(ws.id).catch((e: unknown) => e);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(err).toBeInstanceOf(DiskSyncError);
    expect((err as Error).message).toBe(diskSyncFailedLine(machineAnswer(res)));
    expect((err as { kind?: unknown }).kind).toBeUndefined();
    expect(backend.snapshots).toEqual([]);
    expect(await rt.golden.projects()).toEqual([]);
    expect(await store.get("workspaces", ws.id)).toEqual(before);
  });

  it("a sync the provider refuses to run passes as that refusal and takes nothing", async () => {
    const { rt, advance, backend } = await setup();
    const ws = await loaded(rt, advance);
    const plain = backend.execImpl;
    backend.execImpl = (m, cmd) => {
      if (cmd === DISK_SYNC_CMD) throw new MachineUnreachableError(m.id, "Sandbox is not reachable", 502, machineUnreachableLine("Sandbox is not reachable"));
      return plain(m, cmd);
    };
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toBeInstanceOf(MachineUnreachableError);
    expect(backend.snapshots).toEqual([]);
    expect(await rt.golden.projects()).toEqual([]);
  });

  it("a fork of a project golden boots from its snapshot as the root version's kind and size, carries the project, and its own snapshot still lists under that version", async () => {
    const { rt, advance, backend } = await setup();
    const ws = await loaded(rt, advance);
    const golden = await rt.workspaces.snapshot(ws.id);
    const fork = await rt.workspaces.create({ project: ws.project.id, golden: golden.snapshotId, name: "task-a" });
    expect(fork).toMatchObject({ golden: golden.snapshotId });
    const machine = backend.machines.find(m => m.id === fork.machineId)!;
    expect(machine.spec).toMatchObject({ fromSnapshot: golden.snapshotId, kind: "desktop", cpu: 4, memMb: 8192 });
    expect(backend.puts.filter(p => p.machine === machine.id).some(p => gunzipSync(p.body).toString("utf8").includes("Golden: v12"))).toBe(true);
    const sibling = await rt.workspaces.create({ project: ws.project.id, golden: fork.golden, name: "task-b" });
    expect(sibling).toMatchObject({ golden: golden.snapshotId });
    advance(60_000);
    const again = await rt.workspaces.snapshot(fork.id);
    expect(again).toMatchObject({ golden: "snap_golden-v12", version: 12, projects: [PROJECT], workspaceId: fork.id, workspaceName: "task-a" });
    expect(again.snapshotId).not.toBe(golden.snapshotId);
  });

  it("a fork of a project image that carries the project clones nothing and installs nothing: the checkout is at its path already", async () => {
    const { rt, advance, backend } = await setup();
    const ws = await loaded(rt, advance);
    const golden = await rt.workspaces.snapshot(ws.id);
    expect(golden.projects.map(p => p.dest)).toEqual([ws.project.path]);
    // The disk already holds the checkout, so git refuses a clone into it and the lockfile there would name an
    // install: a fork that ran either of them is the failure this guards.
    const plain = backend.execImpl;
    backend.execImpl = (m, cmd) => {
      if (cmd.includes("git clone")) return { exitCode: 128, stdout: "", stderr: `fatal: destination path '${ws.project.path}' already exists and is not an empty directory` };
      if (cmd.startsWith("ls -A")) return { exitCode: 0, stdout: "pnpm-lock.yaml\npackage.json\n", stderr: "" };
      return plain(m, cmd);
    };
    const fork = await rt.workspaces.create({ project: ws.project.id, golden: golden.snapshotId, name: "task-a" });
    const machine = backend.machines.find(m => m.id === fork.machineId)!;
    expect(machine.execLog.join("\n")).not.toContain("git clone");
    expect(machine.execLog.join("\n")).not.toContain("pnpm install");
    expect(fork.project.path).toBe(ws.project.path);
  });

  it("a fork of a project image that carries another project's checkout still clones: the rule reads the path, not the word --from", async () => {
    const { rt, advance, backend } = await setup();
    const ws = await loaded(rt, advance);
    const golden = await rt.workspaces.snapshot(ws.id);
    const other = await projectOn(rt, "default", "https://github.com/dev/other.git");
    expect(other.path).not.toBe(ws.project.path);
    const fork = await rt.workspaces.create({ project: other.id, golden: golden.snapshotId, name: "other-task" });
    const machine = backend.machines.find(m => m.id === fork.machineId)!;
    expect(machine.execLog.join("\n")).toContain(`git clone https://github.com/dev/other.git ${other.path}`);
  });

  it("over the wire: workspaces.snapshot replies with the project golden, projectGoldens.list with every one, and a refusal carries its kind", async () => {
    const { rt, advance } = await setup();
    const ws = await loaded(rt, advance);
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    const client = await WsClient.connect(srv.port, { token: "t" });
    try {
      const taken = await client.request("workspaces.snapshot", { workspaceId: ws.id });
      expect(taken).toMatchObject({ ok: true, projectGolden: { projects: [PROJECT], golden: "snap_golden-v12", version: 12, workspaceId: ws.id } });
      const listed = await client.request("projectGoldens.list", {});
      expect(listed).toMatchObject({ ok: true, projectGoldens: [taken["projectGolden"]] });
      await rt.workspaces.nap(ws.id);
      await rt.workspaces.wake(ws.id);
      const refused = await client.request("workspaces.snapshot", { workspaceId: ws.id });
      expect(refused).toMatchObject({ ok: false, kind: "notFirstLife" });
    } finally {
      client.close();
    }
  });
});

describe("removing a project image", () => {
  /** A project image taken off a workspace of the project, and the provider's delete as the stub answers it. */
  async function taken() {
    const s = await setup();
    const ws = await loaded(s.rt, s.advance);
    const golden = await s.rt.workspaces.snapshot(ws.id);
    const deleteSnapshot = s.backend.deleteSnapshot.bind(s.backend);
    const listSnapshots = s.backend.listSnapshots.bind(s.backend);
    return { ...s, ws, golden, deleteSnapshot, listSnapshots };
  }

  it("deletes the snapshot at the provider, reads the listing until the id leaves, and drops the record last", async () => {
    const { rt, backend, store, golden, deleteSnapshot, listSnapshots } = await taken();
    let deleted = false;
    backend.deleteSnapshot = async id => {
      await deleteSnapshot(id);
      deleted = true;
    };
    // The listing lags the delete by one read, as a best-effort listing may; the record stands through the wait.
    const held: unknown[] = [];
    let reads = 0;
    backend.listSnapshots = async () => {
      const rows = await listSnapshots();
      if (!deleted) return rows;
      held.push(await store.get("project-goldens", golden.snapshotId));
      return ++reads === 1 ? [...rows, { id: golden.snapshotId, sizeBytes: 1 }] : rows;
    };
    expect(await rt.golden.removeProject(golden.snapshotId)).toEqual({ projectGolden: golden, alreadyGone: false });
    expect(reads).toBe(2);
    expect(held).toEqual([golden, golden]);
    expect(backend.snapshots).toEqual([]);
    expect(await store.get("project-goldens", golden.snapshotId)).toBeUndefined();
    expect(await rt.golden.projects()).toEqual([]);
    expect((await rt.image.get()).projects).toEqual([]);
  });

  it("is refused while a workspace stands on the image, running, napping or gone, naming them, and nothing is deleted", async () => {
    const { rt: first, backend, store, ws, golden } = await taken();
    await first.workspaces.create({ project: ws.project.id, golden: golden.snapshotId, name: "task-a" });
    const napping = await first.workspaces.create({ project: ws.project.id, golden: golden.snapshotId, name: "task-b" });
    await first.workspaces.nap(napping.id);
    const lost = await first.workspaces.create({ project: ws.project.id, golden: golden.snapshotId, name: "task-c" });
    await first.close();
    // A machine the provider lost while no host ran reads gone at the next load, and its record still stands.
    backend.machines.find(m => m.id === lost.machineId)!.killed = true;
    const rt = createRuntime({ backend, store, adapters: {}, hostId: HOST, killConfirm: QUICK });
    await until(async () => (await rt.workspaces.get(lost.id)).phase === "gone");
    await expect(rt.golden.removeProject(golden.snapshotId)).rejects.toMatchObject({ kind: "conflict", message: projectImageInUseRefusal(golden.snapshotId, ["task-a", "task-b", "task-c"]) });
    expect(backend.snapshots.map(s => s.id)).toEqual([golden.snapshotId]);
    expect(await store.get("project-goldens", golden.snapshotId)).toEqual(golden);
  });

  it("keeps the record and says the image could not be read gone when the listing holds the id through the window", async () => {
    const { rt, backend, store, golden, listSnapshots } = await taken();
    backend.listSnapshots = async () => [...(await listSnapshots()), { id: golden.snapshotId, sizeBytes: 1 }];
    await expect(rt.golden.removeProject(golden.snapshotId)).rejects.toThrow(`project image ${golden.snapshotId} could not be read gone within 0 s of the delete answering, so its record stays; run wsp image remove ${golden.snapshotId} again`);
    expect(await store.get("project-goldens", golden.snapshotId)).toEqual(golden);
    expect(await rt.golden.projects()).toEqual([golden]);
  });

  it("drops the record of a snapshot the provider already lost, with the line saying it was gone", async () => {
    const { rt, backend, store, golden } = await taken();
    backend.deleteSnapshot = async () => {
      throw Object.assign(new Error("Not found"), { kind: "missing", status: 404 });
    };
    expect(await rt.golden.removeProject(golden.snapshotId)).toEqual({ projectGolden: golden, alreadyGone: true });
    expect(await store.get("project-goldens", golden.snapshotId)).toBeUndefined();
  });

  it("keeps the record on any other refusal and fails in the provider's words with its kind and status", async () => {
    const { rt, backend, store, golden } = await taken();
    backend.deleteSnapshot = async () => {
      throw Object.assign(new Error("SnapshotHasChildren"), { kind: "conflict", status: 409 });
    };
    await expect(rt.golden.removeProject(golden.snapshotId)).rejects.toMatchObject({
      kind: "conflict",
      status: 409,
      message: expect.stringMatching(new RegExp(`^project image ${golden.snapshotId} was not removed: the provider answered 409 SnapshotHasChildren \\(no request id from the provider, at \\S+\\); its record stays$`)),
    });
    expect(await store.get("project-goldens", golden.snapshotId)).toEqual(golden);
  });

  it("refuses a golden version's snapshot and an id nothing holds as no project image", async () => {
    const { rt, backend } = await taken();
    for (const id of ["snap_golden-v12", "snap_nope"]) await expect(rt.golden.removeProject(id)).rejects.toMatchObject({ kind: "not-found", message: noProjectImageLine(id) });
    expect(backend.snapshots).toHaveLength(1);
  });

  it("image.get carries each project image's size off the listing, one listing per place, and none where the provider lists no snapshots", async () => {
    const { rt, backend, golden, ws, advance, listSnapshots } = await taken();
    let listings = 0;
    backend.listSnapshots = async () => (listings++, listSnapshots());
    expect((await rt.image.get()).projects).toEqual([{ ...golden, sizeBytes: backend.snapshotBytes }]);
    const one = listings;
    advance(60_000);
    const second = await rt.workspaces.snapshot(ws.id);
    listings = 0;
    expect((await rt.image.get()).projects).toEqual([golden, second].map(g => ({ ...g, sizeBytes: backend.snapshotBytes })));
    expect(listings).toBe(one);
    backend.capabilities.snapshotListing = false;
    expect((await rt.image.get()).projects).toEqual([golden, second]);
  });

  it("image.get lists a project image whose place this host no longer holds without a size, beside one it can size", async () => {
    const { rt, backend, store, golden } = await taken();
    const elsewhere = { ...golden, snapshotId: "snap_elsewhere", place: "left", createdAt: "2026-09-07T00:00:00.000Z" };
    await store.put("project-goldens", elsewhere.snapshotId, elsewhere);
    expect((await rt.image.get()).projects).toEqual([{ ...golden, sizeBytes: backend.snapshotBytes }, elsewhere]);
  });

  it("over the wire: projectGoldens.remove replies with the record and the line, a refusal carries its kind, and the op is a paired device's and no thread's", async () => {
    const { rt, golden } = await taken();
    expect(DEVICE_OPS).toContain("projectGoldens.remove");
    expect(THREAD_OPS).not.toContain("projectGoldens.remove");
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    const client = await WsClient.connect(srv.port, { token: "t" });
    try {
      expect(await client.request("projectGoldens.remove", { snapshotId: golden.snapshotId })).toEqual({ id: expect.anything(), ok: true, projectGolden: golden, alreadyGone: false });
      expect(await client.request("projectGoldens.remove", { snapshotId: golden.snapshotId })).toMatchObject({ ok: false, kind: "not-found", error: noProjectImageLine(golden.snapshotId) });
    } finally {
      client.close();
    }
  });
});
