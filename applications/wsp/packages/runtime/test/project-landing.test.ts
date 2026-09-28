// SPDX-License-Identifier: AGPL-3.0-only
// What an add does on the computer holding the project: the clone, the files
// the person ticked, the install the lockfile picks, and on a provider the
// image every workspace of the project forks. Over the stub backend, so every
// command the machine was asked to run is read back here.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISK_SYNC_CMD } from "@wsp/engine";
import { addedProjectOn, addingProjectLine, HERE_PLACE_ID, seedMemoryKeptLine, type AdapterEvent, type EventUnion, type MachineSpec, type ProjectAddEvent, type SeedChoice, type SeedPlan, type TurnResult } from "@wsp/protocol";
import { MEMORY_KEPT_MARK, MEMORY_STANDS_MARK } from "../src/project-landing.js";
import { copyKey, createRuntime, type HarnessAdapterFactory, type Runtime, type SeedWiring } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeLocal, missesFirstDelete, stubBackend, type StubBackend, type StubMachine } from "./stub-backend.js";

const version = { version: 1, snapshotId: "snap_golden-v1", baseTemplate: "base", setupSha: "s1", createdAt: "2026-09-17T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } };
const REMOTE = "https://github.com/spoo-me/frontend.git";

/** What every adapter this file wires was handed at its launch: the harness, the environment and the folder its
 * agent keys this project's sessions and memory to. */
const launches: { harness: string; env: Record<string, string>; projectKey?: string }[] = [];

/** An adapter that records the environment it was built with and answers a turn at once, one per harness. */
function recordingAdapter(harness: string): HarnessAdapterFactory {
  return ctx => {
    launches.push({ harness, env: { ...ctx.env }, ...(ctx.projectKey !== undefined ? { projectKey: ctx.projectKey } : {}) });
    return {
      steers: false,
      start: o => {
        const sessionId = `00000000-0000-4000-8000-${String(launches.length).padStart(12, "0")}`;
        const result: TurnResult = { status: "completed", text: "ok" };
        const finished = (async () => {
          for (const e of [
            { type: "session.start", sessionId, model: "m" },
            { type: "turn.done", sessionId, result },
            { type: "session.end", sessionId, exitCode: 0, sawResult: true },
          ] as AdapterEvent[]) {
            o.onEvent(e);
          }
          return result;
        })();
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    };
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A git repo in a folder of its own on this computer: the source a seed reads. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-seed-add-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

function plan(folder: string, over: Partial<SeedPlan> = {}): SeedPlan {
  return {
    source: folder,
    remote: REMOTE,
    branch: "refactor/dashboard-polish",
    defaultBranch: "main",
    unpushed: null,
    uncommitted: 2,
    memory: { key: "-Users-dev-spoo-landing", files: 3, bytes: 20_000 },
    files: [
      { path: ".env.local", dir: false, bytes: 4096, kind: "config", row: { id: "next", name: "Next" }, ticked: true },
      { path: "node_modules", dir: true, bytes: 2_600_000_000, kind: "rebuilt", row: { id: "node", name: "Node" }, ticked: false },
    ],
    remembered: false,
    ...over,
  };
}

const TICKED: SeedChoice = { files: [".env.local"], memory: true, commits: false };

/** A host with an image sealed on the computer named, the stub provider as its backend and a folder reader that
 * answers the plan handed in: what an add of a folder on this computer onto a computer that clones needs. */
async function withImage(o: { at?: string; plan: SeedPlan; projects?: string; packed?: Buffer; keepsImages?: boolean; left?: string[] } = { plan: plan("/x") }): Promise<{ rt: Runtime; backend: StubBackend; store: Store; seed: SeedWiring; packs: { plan: SeedPlan; choice: SeedChoice }[] }> {
  const backend = stubBackend();
  // What the computer says about itself: a box keeps project checkouts on a disk of its own and no image at all,
  // a provider keeps images and no checkout.
  if (o.projects !== undefined) (backend as { projects?: string }).projects = o.projects;
  if (o.keepsImages === false) backend.capabilities.images = false;
  const store = memoryStore();
  await store.put("goldens", copyKey(o.at ?? "default", "default"), { head: 1, versions: [version] });
  const packs: { plan: SeedPlan; choice: SeedChoice }[] = [];
  const seed: SeedWiring = {
    plan: async () => o.plan,
    pack: async ({ plan: p, choice }) => {
      packs.push({ plan: p, choice });
      return { tar: o.packed ?? Buffer.from("seed archive"), files: choice.files.length, bytes: 12, commits: 0, left: o.left ?? [] };
    },
  };
  const root = mkdtempSync(join(tmpdir(), "wsp-add-local-"));
  roots.push(root);
  const adapters = { claude: recordingAdapter("claude"), codex: recordingAdapter("codex") };
  return { rt: createRuntime({ backend, store, adapters, local: fakeLocal(root), seed, killConfirm: { graceMs: 20, pollMs: 1 } }), backend, store, seed, packs };
}

const stages = (events: readonly EventUnion[]): ProjectAddEvent[] => events.filter((e): e is ProjectAddEvent & { seq: number } => e.type === "project.add");

/** Every command every machine of this backend was asked to run, oldest first. */
const commands = (backend: StubBackend): string => backend.machines.flatMap(m => m.execLog).join("\n");
/** The spec of every machine it was asked for, in order. */
const specs = (backend: StubBackend): MachineSpec[] => backend.machines.map(m => m.spec);
const stopped = (backend: StubBackend): number => backend.machines.filter(m => m.killed).length;
/** Every machine this backend makes from now on takes its first delete on the copy that never held it. */
function missingFirstDeletes(backend: StubBackend): void {
  const create = backend.create.bind(backend);
  backend.create = async spec => {
    const m = await create(spec);
    missesFirstDelete(m as StubMachine);
    return m;
  };
}
/** What the machine answers one command with, over the probe the stub answers by default. */
function answering(backend: StubBackend, reply: (cmd: string) => { exitCode: number; stdout: string; stderr: string } | undefined): void {
  const own = backend.execImpl;
  backend.execImpl = (m, cmd) => reply(cmd) ?? own(m, cmd);
}

describe("a folder seeding a project on a computer that clones", () => {
  it("clones, lands the seed, installs and says each step as it happens", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    // What the machine answers the listing of the checkout's root with: an npm lockfile, so the node row's install runs.
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package.json\npackage-lock.json\n.env.local\n", stderr: "" } : undefined));
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(stages(events).map(e => e.stage)).toEqual(["planned", "cloning", "seeding", "installing", "done"]);
    // The folder as this host resolved it, which on a Mac is the real path under /private.
    expect(project.path).toMatch(/spoo-landing|wsp-seed-add-/);
    const ran = commands(backend);
    // The clone carries the remote the folder's own origin gave, and it lands at the path the project has inside
    // every workspace of it, which is where the install then runs: an install that writes an absolute path names
    // what the workspaces read rather than the folder the computer keeps the checkout in.
    expect(ran).toContain(`git clone ${REMOTE} ${project.path}`);
    expect(ran).toContain(`cd '${project.path}' && npm ci`);
    expect(specs(backend)[0]?.binds).toEqual([
      { source: `/wsp/projects/${project.id}`, target: `/wsp/projects/${project.id}` },
      { source: `/wsp/projects/${project.id}/checkout`, target: project.path },
    ]);
    // The seed is landed and unpacked before the install runs, and wsp's own folder inside the checkout is removed.
    const order = [ran.indexOf("tar -xzf"), ran.indexOf("npm ci")];
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[1]).toBeGreaterThan(order[0]!);
    expect(ran).toContain(".wsp-seed");
    // What the menu said would travel is what the record holds: one ticked file of its own bytes, the memory
    // row's own count, and the commits git read back on that computer.
    expect(project.seeded).toMatchObject({ files: 1, bytes: 4096, memory: "landed", memoryFiles: 3, commits: 0 });
    expect(project.installed).toMatchObject({ row: "node", command: "npm ci" });
    expect(project.remote).toBe(REMOTE);
  });

  it("runs every ecosystem the checkout's own root names a lockfile for, in catalogue order", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package-lock.json\nCargo.lock\n", stderr: "" } : undefined));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    const ran = commands(backend);
    expect(ran.indexOf("npm ci")).toBeGreaterThanOrEqual(0);
    expect(ran.indexOf("cargo fetch --locked")).toBeGreaterThan(ran.indexOf("npm ci"));
    expect(project.installed).toMatchObject({ row: "node, rust", command: "npm ci; cargo fetch --locked" });
  });

  it("packs only what the person ticked, and nothing runs an install where no lockfile picks one", async () => {
    const folder = repo();
    const { rt, backend, packs } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package.json\nREADME.md\n", stderr: "" } : undefined));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(packs).toEqual([{ plan: plan(folder), choice: TICKED }]);
    expect(project.installed).toBeUndefined();
    expect(commands(backend)).not.toContain("npm ci");
  });

  it("names the logins a ticked folder held that never travel, so nothing they ticked is dropped in silence", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects", left: ["config/.netrc"] });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: { files: ["config"], memory: false, commits: false } });
    expect(project.notice).toBe("1 login inside the folders you ticked stayed on this computer: config/.netrc");
  });

  it("says nothing of the kind where every ticked path travelled", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    expect((await rt.projects.add({ source: folder, on: "default", seed: TICKED })).notice).toBeUndefined();
  });

  it("keeps the project's memory where the agent on that computer reads it, and no workspace of it mounts a thing for it", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    // The key is the folder's own here, so the memory the agent already kept for it is the memory it keeps.
    expect(project.memoryKey).toBe("-Users-dev-spoo-landing");
    // The agent's own state home on the computer, which every workspace of it reads from the computer itself:
    // nothing of wsp's is mounted over the computer's home, so no mount point of a workspace's is left on it.
    expect(project.memoryDir).toBe(`/root/.claude-cfg/projects/${project.memoryKey}/memory`);
    const before = backend.machines.length;
    await rt.workspaces.create({ project: project.id, name: "work" });
    expect(specs(backend)[before]?.binds).toBeUndefined();
    // The seed's memory is moved where no memory stands, and no memory is ever removed: an empty folder there is
    // taken by an rmdir, which can never take a byte of what the agent wrote.
    const ran = commands(backend);
    expect(ran).toContain(`rmdir '${project.memoryDir}' 2>/dev/null || true`);
    expect(ran).toContain(`if [ -e '${project.memoryDir}' ]`);
    expect(ran).not.toContain(`rm -rf '${project.memoryDir}'`);
  });

  it("leaves the memory the agent has kept on that computer alone, records that it did and says so", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    // The computer answers the clone with the mark the script prints where a memory folder already stands at
    // the agent's path: what is there is the agent's own work for this project.
    answering(backend, cmd => (cmd.includes(MEMORY_KEPT_MARK) ? { exitCode: 0, stdout: `${MEMORY_KEPT_MARK}\n`, stderr: "" } : undefined));
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    // One word for what the seed's memory did there, rather than a travelled flag beside a kept one: the memory
    // came and the computer's own stayed, so nothing of the seed's was landed.
    expect(project.seeded).toMatchObject({ memory: "kept", memoryFiles: 3 });
    expect(stages(events).map(e => e.message)).toContain(seedMemoryKeptLine("default"));
    // And a computer with nothing there says nothing of the kind and records that the memory landed.
    const second = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(second.backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const landed = await second.rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(landed.seeded?.memory).toBe("landed");
  });

  it("says what travels and then what landed, in the counts the menu itself showed", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder, { unpushed: { commits: 1, base: "abc123" }, branch: "main", defaultBranch: "main" }), projects: "/wsp/projects", keepsImages: false });
    answering(backend, cmd => (cmd.includes("am --3way") ? { exitCode: 0, stdout: "1\n", stderr: "" } : undefined));
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const seeded = await rt.projects.add({ source: folder, on: "default", seed: { files: [".env.local"], memory: true, commits: true } });
    // The planned line says what is being added and from where, and counts nothing: the count of ticked files
    // alone read as the whole of a seed that was carrying a memory folder too. Read off the protocol's own
    // sentence, with the source as the record holds it, which on a Mac is the real path under /private.
    expect(stages(events)[0]?.message).toBe(addingProjectLine(seeded.name, seeded.source, true));
    const seeding = stages(events).filter(e => e.stage === "seeding").map(e => e.message);
    expect(seeding).toEqual([`Seeding 1 file (4 KB), Claude Code memory (3 files, 20 KB), 1 commit the remote does not have, from ${folder}.`, "1 commit landed"]);
  });

  it("says no commits to land where that computer's git found none to add, and nothing of commits where none travelled", async () => {
    const folder = repo();
    const none = await withImage({ plan: plan(folder, { unpushed: { commits: 1, base: "abc123" }, branch: "main", defaultBranch: "main" }), projects: "/wsp/projects", keepsImages: false });
    // The patch went on and left the checkout where it was: the clone already had the person's work.
    answering(none.backend, cmd => (cmd.includes("am --3way") ? { exitCode: 0, stdout: "0\n", stderr: "" } : undefined));
    const events: EventUnion[] = [];
    none.rt.events.on("*", e => events.push(e));
    await none.rt.projects.add({ source: folder, on: "default", seed: { files: [".env.local"], memory: true, commits: true } });
    expect(stages(events).filter(e => e.stage === "seeding").map(e => e.message).at(-1)).toBe("no commits to land");
    // A seed carrying no commits says nothing about commits at all: the line that travelled named none.
    const kept = await withImage({ plan: plan(folder), projects: "/wsp/projects", keepsImages: false });
    answering(kept.backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const quiet: EventUnion[] = [];
    kept.rt.events.on("*", e => quiet.push(e));
    await kept.rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(stages(quiet).filter(e => e.stage === "seeding").map(e => e.message)).toEqual([`Seeding 1 file (4 KB), Claude Code memory (3 files, 20 KB), from ${folder}.`]);
  });

  it("the record holds the ticked bytes the menu showed, never the bytes of the archive they went in", async () => {
    const folder = repo();
    // The archive is far bigger than the one row the person ticked: the menu's sum is what the record keeps, so
    // the row they read and the record they can read back say one number.
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects", keepsImages: false, packed: Buffer.alloc(179) });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const nothing = await rt.projects.add({ source: folder, on: "default", seed: { files: [], memory: true, commits: false } });
    expect(nothing.seeded).toMatchObject({ files: 0, bytes: 0, memory: "landed", memoryFiles: 3 });
  });

  it("leaves the checkout on the computer, and every workspace of the project takes its own copy of it", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects", keepsImages: false });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(project.checkout).toBe(`/wsp/projects/${project.id}/checkout`);
    const before = backend.machines.length;
    await rt.workspaces.create({ project: project.id, name: "work" });
    // The copy is mounted at the path the project has inside, which for a folder seeded from this computer is the
    // folder's own path, and nothing clones over it.
    expect(specs(backend)[before]?.copy).toEqual({ from: project.checkout, at: project.path });
    expect(backend.machines[before]?.execLog.join("\n")).not.toContain("git clone");
  });

  it("the machine that did the work is stopped whatever happened, and a failed install is the add's own failure", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, cmd => {
      if (cmd.startsWith("ls -A")) return { exitCode: 0, stdout: "package-lock.json\n", stderr: "" };
      if (cmd.includes("npm ci")) return { exitCode: 1, stdout: "", stderr: "npm error code ENOSPC\nnpm error nospc ENOSPC: no space left on device\n" };
      return undefined;
    });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    await expect(rt.projects.add({ source: folder, on: "default", seed: TICKED })).rejects.toThrow(/no space left on device/);
    expect(stages(events).at(-1)?.stage).toBe("failed");
    // Nothing is left running at the provider, and no project was recorded.
    expect(stopped(backend)).toBe(1);
    expect(await rt.projects.list()).toEqual([]);
  });
});

describe("a computer that keeps no image of its own", () => {
  it("is worked in a copy of its own directories: nothing is forked from an image and the clone still lands", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects", keepsImages: false });
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package-lock.json\n", stderr: "" } : undefined));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(specs(backend)[0]?.fromSnapshot).toBeUndefined();
    expect(commands(backend)).toContain(`git clone ${REMOTE}`);
    expect(project.installed).toMatchObject({ command: "npm ci" });
    // The machine the work ran in is stopped, and the project's memory sits where that computer's own agent
    // reads it.
    expect(stopped(backend)).toBe(1);
    expect(project.memoryDir).toBe(`/root/.claude-cfg/projects/${project.memoryKey}/memory`);
  });
});

describe("a project on a provider", () => {
  it("becomes the image every workspace of it forks, sealed once from the machine that cloned and installed", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder) });
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package-lock.json\n", stderr: "" } : undefined));
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(stages(events).map(e => e.stage)).toEqual(["planned", "cloning", "seeding", "installing", "imaging", "done"]);
    expect(project.image?.snapshotId).toMatch(/^snap_/);
    expect(backend.snapshots.length).toBe(1);
    // The project's memory rides that image, so there is nothing of the computer's to bind into a workspace.
    expect(project.memoryDir).toBe(`/root/.claude-cfg/projects/${project.memoryKey}/memory`);
    const before = backend.machines.length;
    await rt.workspaces.create({ project: project.id, name: "work" });
    expect(specs(backend)[before]?.binds).toBeUndefined();
    // And that workspace forks the project's own image rather than the head of this host's.
    expect(specs(backend)[before]?.fromSnapshot).toBe(project.image?.snapshotId);
    // A copy forked from the project image holds the checkout already: nothing clones into it again.
    expect(backend.machines.flatMap(m => m.execLog).filter(cmd => cmd.includes("git clone")).length).toBe(1);
  });

  it("syncs the builder's disk before the provider is asked for the project's image", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder) });
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package-lock.json\n", stderr: "" } : undefined));
    const synced: number[] = [];
    backend.beforeSnapshot = m => {
      synced.push(m.execLog.filter(c => c === DISK_SYNC_CMD).length);
    };
    await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(synced).toEqual([1]);
  });

  it("the machine it was built from is asked again behind the add when its first delete reached the copy that never held it", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder) });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    missingFirstDeletes(backend);
    await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    await vi.waitFor(() => expect(stopped(backend)).toBe(1));
    await rt.close();
  });

  it("the machine it was built from is stopped, and the person's own folder stays on this computer", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder) });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(stopped(backend)).toBe(1);
    // The seed archive is what travelled, and it went to the machine as one file under wsp's own folder there.
    expect(backend.puts.map(p => p.path).every(path => path.startsWith("/tmp/"))).toBe(true);
    expect(backend.puts.length).toBe(1);
  });
});

describe("an ssh remote a box could not open", () => {
  it("is recorded as its host's https url, since no computer wsp forks carries a key of the person's", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder, { remote: "git@github.com:spoo-me/frontend.git" }) });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(project.remote).toBe("https://github.com/spoo-me/frontend.git");
    expect(commands(backend)).toContain("git clone https://github.com/spoo-me/frontend.git");
  });

  it("a remote on a host the catalog carries no command line for is cloned as it stands", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder, { remote: "git@git.example.com:dev/thing.git" }) });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(project.remote).toBe("git@git.example.com:dev/thing.git");
  });
});

describe("a repo named by owner and repo", () => {
  it("is cloned through the host's own command line, which the computer's image is checked for first", async () => {
    const { rt, backend } = await withImage({ plan: plan("/x") });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: "spoo-me/frontend", on: "default" });
    expect(project.source).toEqual({ kind: "github", repo: "spoo-me/frontend" });
    expect(project.remote).toBe("https://github.com/spoo-me/frontend.git");
    // Nothing runs at the add for a repo the computer clones by itself; the workspace's own create does that.
    expect(commands(backend)).not.toContain("gh repo clone");
    const before = backend.machines.length;
    await rt.workspaces.create({ project: project.id, name: "work" });
    const ran = commands(backend);
    expect(ran).toContain("command -v gh");
    expect(ran).toContain("gh auth setup-git");
    expect(ran).toContain("gh repo clone spoo-me/frontend /root/frontend");
    expect(specs(backend)[before]?.binds).toBeUndefined();
  });

  it("a gitlab repo is named with its host and cloned through glab", async () => {
    const { rt, backend } = await withImage({ plan: plan("/x") });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: "gitlab.com/dev/thing", on: "default" });
    expect(project.source).toEqual({ kind: "gitlab", repo: "dev/thing" });
    await rt.workspaces.create({ project: project.id, name: "work" });
    expect(commands(backend)).toContain("glab repo clone dev/thing /root/thing");
  });
});

describe("the key an agent's launch carries", () => {
  it("is the project's own for an agent whose catalog row names the variable, and nothing for one that names none", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder) });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    const ws = await rt.workspaces.create({ project: project.id, name: "work" });
    // The agent whose row names the variable is told the project's own key, which is the folder's key on the
    // computer it was seeded from and not the path the checkout took there.
    expect(await launchKey(rt, ws.id, "claude")).toBe(project.memoryKey);
    // An agent whose row names none is told nothing and keys off the folder its turn runs in.
    expect(await launchKey(rt, ws.id, "codex")).toBeUndefined();
    // Nothing of it rides the launch environment: the adapter sets it after its own strip.
    expect(Object.keys(launches.at(-1)?.env ?? {}).some(key => key.endsWith("PROJECT_DIR_NAME"))).toBe(false);
  });
});

/** The key one harness's launch on a workspace was handed, read off the adapter the runtime built for it. */
async function launchKey(rt: Runtime, workspaceId: string, harness: string): Promise<string | undefined> {
  const session = await rt.sessions.start(workspaceId, { prompt: "hi", harness });
  await session.finished;
  return launches.filter(l => l.harness === harness).at(-1)?.projectKey;
}

describe("the menu a folder's add reads", () => {
  it("is the reader's own plan, with the ticks a choice remembered for that folder leaves on it", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    // Nothing is remembered yet: the catalogue's own ticks stand and the plan says so.
    const first = await rt.projects.seedPlan(folder);
    expect(first.remembered).toBe(false);
    expect(first.files.filter(f => f.ticked).map(f => f.path)).toEqual([".env.local"]);
    // A choice kept for this folder ticks exactly what it named, whatever the catalogue would have.
    await rt.projects.add({ source: folder, on: "default", seed: { files: ["node_modules"], memory: false, commits: false, remember: true } });
    const again = await rt.projects.seedPlan(folder);
    expect(again.remembered).toBe(true);
    expect(again.files.filter(f => f.ticked).map(f => f.path)).toEqual(["node_modules"]);
  });

  it("never ticks a path that never travels, whatever was remembered for the folder", async () => {
    const folder = repo();
    const login = { path: ".git-credentials", dir: false, bytes: 300, kind: "never" as const, row: { id: "logins", name: "logins" }, ticked: false };
    const { rt, backend } = await withImage({ plan: plan(folder, { files: [login] }), projects: "/wsp/projects" });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await rt.projects.add({ source: folder, on: "default", seed: { files: [".git-credentials"], memory: false, commits: false, remember: true } });
    const again = await rt.projects.seedPlan(folder);
    expect(again.files.every(f => !f.ticked)).toBe(true);
  });
});

describe("a repo added by url on a computer the person owns", () => {
  /** That computer as the stub stands for one: it keeps project checkouts on a disk of its own and no image. */
  const box = async (): Promise<Awaited<ReturnType<typeof withImage>>> => withImage({ plan: plan("/x"), projects: "/wsp/projects", keepsImages: false });

  it("is cloned once by the add into the folder wsp keeps for it there, with nothing of it under the computer's own home", async () => {
    const { rt, backend } = await box();
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package.json\npackage-lock.json\n", stderr: "" } : undefined));
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const project = await rt.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "default", name: "landing-906" });
    // The same stages a seeded project's add prints, without the one for a seed there was none of.
    expect(stages(events).map(e => e.stage)).toEqual(["planned", "cloning", "installing", "done"]);
    expect(stages(events)[0]?.message).toBe("landing-906 from https://github.com/spoo-me/spoo-ts, nothing seeded.");
    // The done stage carries the add's one sentence about where the project is, which is the line the command
    // line and the tool answer with, so no door says that fact twice.
    expect(stages(events).at(-1)?.message).toBe(addedProjectOn(project, "default"));
    // The checkout is wsp's own folder on that computer, and the path inside a workspace of it is not under the
    // computer's home: a copy bound there would leave its mount point on the computer itself.
    expect(project.checkout).toBe(`/wsp/projects/${project.id}/checkout`);
    expect(project.path).toBe("/srv/landing-906");
    // The memory is where the agent on that computer reads it, under the computer's own home, which every
    // workspace of the project sees from the computer itself.
    expect(project.memoryDir).toBe("/root/.claude-cfg/projects/-srv-landing-906/memory");
    expect(project.memoryKey).toBe("-srv-landing-906");
    const ran = commands(backend);
    expect(ran).toContain("git clone https://github.com/spoo-me/spoo-ts /srv/landing-906");
    expect(ran).not.toContain("/root/landing-906");
    // The worker the work ran in binds wsp's folder at its own path and the checkout where the workspaces read it.
    expect(specs(backend)[0]?.binds).toEqual([
      { source: `/wsp/projects/${project.id}`, target: `/wsp/projects/${project.id}` },
      { source: project.checkout, target: "/srv/landing-906" },
    ]);
    expect(project.installed).toMatchObject({ row: "node", command: "npm ci" });
    // Nothing of the add is left running, and nothing was seeded: no archive travelled.
    expect(stopped(backend)).toBe(1);
    expect(backend.puts).toEqual([]);
    expect(project.seeded).toBeUndefined();
  });

  it("the machine the add worked in is asked again behind the add when its first delete reached the copy that never held it", async () => {
    const { rt, backend } = await box();
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    missingFirstDeletes(backend);
    await rt.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "default", name: "landing-906" });
    await vi.waitFor(() => expect(stopped(backend)).toBe(1));
    await rt.close();
  });

  it("is copied into every workspace of it, two in a row, and neither of them clones anything", async () => {
    const { rt, backend } = await box();
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "default", name: "landing-906" });
    const cloned = (): number => backend.machines.flatMap(m => m.execLog).filter(cmd => cmd.includes("git clone")).length;
    expect(cloned()).toBe(1);
    for (const name of ["proof one", "proof two"]) {
      const before = backend.machines.length;
      await rt.workspaces.create({ project: project.id, name });
      expect(specs(backend)[before]?.copy).toEqual({ from: project.checkout, at: "/srv/landing-906" });
      expect(backend.machines[before]?.execLog.join("\n")).not.toContain("git clone");
    }
    // The clone the add ran is still the only one: the second workspace is a copy of the same checkout.
    expect(cloned()).toBe(1);
  });

  it("an add that failed on the computer leaves nothing of the project there and records nothing", async () => {
    const { rt, backend } = await box();
    answering(backend, cmd => {
      if (cmd.startsWith("ls -A")) return { exitCode: 0, stdout: "package-lock.json\n", stderr: "" };
      if (cmd.includes("npm ci")) return { exitCode: 1, stdout: "", stderr: "npm error code ENOSPC\nnpm error nospc ENOSPC: no space left on device\n" };
      return undefined;
    });
    // Whether the worker was already stopped when the sweep ran: those folders are its binds' own sources while
    // it lives, so the sweep waits for it.
    const workerStopped: boolean[] = [];
    const own = backend.onComputer!.bind(backend);
    backend.onComputer = async (cmd, opts) => {
      workerStopped.push(backend.machines.every(m => m.killed));
      return own(cmd, opts);
    };
    await expect(rt.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "default", name: "landing-906" })).rejects.toThrow(/no space left on device/);
    expect(await rt.projects.list()).toEqual([]);
    // The folder the bind made on that computer goes with it, so the same name can be added again.
    expect(backend.computerLog).toEqual([expect.stringMatching(/^rm -rf '\/wsp\/projects\/pr_[0-9a-f]{8}'$/)]);
    expect(stopped(backend)).toBe(1);
    expect(workerStopped).toEqual([true]);
  });

  it("is taken away with the folder wsp made for it, in one sentence naming that folder", async () => {
    const { rt, backend } = await box();
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "default", name: "landing-906" });
    const { said } = await rt.projects.remove(project.id);
    // One command on the computer: it reads whether a memory folder for this project stands there and takes
    // wsp's own folder away, so the sentence names the memory only where there is one.
    expect(backend.computerLog).toEqual([expect.stringContaining(`rm -rf '/wsp/projects/${project.id}'`)]);
    expect(backend.computerLog[0]).toContain(`[ -d '${project.memoryDir}' ]`);
    expect(said).toBe(`landing-906 is no longer a project on default; the folder wsp kept for it there, /wsp/projects/${project.id}, is gone with its checkout`);
    expect(await rt.projects.list()).toEqual([]);
  });

  it("names the memory its agent keeps there only where a folder of it stands on the computer", async () => {
    const { rt, backend } = await box();
    // The computer answers the remove's own read with the mark: a thread ran there, so the agent's memory for
    // this project stands under its state home and stays when the project goes.
    answering(backend, cmd => (cmd.includes(MEMORY_STANDS_MARK) && cmd.includes("rm -rf") ? { exitCode: 0, stdout: `${MEMORY_STANDS_MARK}\n`, stderr: "" } : undefined));
    const project = await rt.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "default", name: "landing-906" });
    const { said } = await rt.projects.remove(project.id);
    expect(said).toBe(`landing-906 is no longer a project on default; the folder wsp kept for it there, /wsp/projects/${project.id}, is gone with its checkout, and the memory its agent keeps on that computer stays`);
  });

  it("a record from before the add cloned it refuses a workspace, before a machine is asked for", async () => {
    const backend = stubBackend();
    (backend as { projects?: string }).projects = "/wsp/projects";
    backend.capabilities.images = false;
    const store = memoryStore();
    // The shape the first road left on a box: a repo recorded with no checkout, whose path is under the
    // computer's own home.
    await store.put("projects", "pr_old", { id: "pr_old", name: "spoo-landing", computer: "default", source: { kind: "git", url: "https://github.com/spoo-me/frontend" }, path: "/root/spoo-landing", createdAt: "2026-09-17T00:00:00.000Z" });
    const root = mkdtempSync(join(tmpdir(), "wsp-add-old-"));
    roots.push(root);
    const rt = createRuntime({ backend, store, adapters: {}, local: fakeLocal(root) });
    const before = backend.machines.length;
    await expect(rt.workspaces.create({ project: "pr_old", name: "work" })).rejects.toThrow(
      "spoo-landing was recorded before a project was cloned once on its computer, so default holds no checkout for a workspace to copy; wsp projects remove spoo-landing, then wsp add https://github.com/spoo-me/frontend --on default",
    );
    // No machine was asked for and no workspace was written: a refusal after either leaves a record for a fork
    // that never happened.
    expect(backend.machines.length).toBe(before);
    expect(await rt.workspaces.list()).toEqual([]);
    // And the remove it names takes the folder wsp had made for it there, whatever the record is missing.
    const { said } = await rt.projects.remove("pr_old");
    expect(backend.computerLog).toEqual([expect.stringContaining("rm -rf '/wsp/projects/pr_old'")]);
    expect(said).toContain("no longer a project on default");
  });
});

describe("a project taken away from this computer or from a provider", () => {
  it("runs nothing on any computer, and each says what is true of it", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder) });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    // A project at the provider whose add sealed an image of it: the image stays, since no verb deletes one yet.
    const at = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    const there = await rt.projects.remove(at.id);
    expect(there.said).toBe(`${at.name} is no longer a project on default; its project image ${at.image?.snapshotId} stays at the provider`);
    // And a folder of the person's own here, which is where it was.
    const here = await rt.projects.add({ source: repo() });
    const said = (await rt.projects.remove(here.id)).said;
    expect(said).toBe(`${here.name} is no longer a project here; its code is where it was`);
    expect(backend.computerLog).toEqual([]);
  });

  it("a folder here is recorded on a host that has sealed no image, since nothing of it is forked anywhere", async () => {
    const backend = stubBackend();
    const root = mkdtempSync(join(tmpdir(), "wsp-add-noimage-"));
    roots.push(root);
    // No goldens document at all: this host has sealed nothing.
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, local: fakeLocal(root) });
    // The folder as this host resolved it, which on a Mac is the real path under /private.
    const recorded = await rt.projects.add({ source: repo() });
    expect(recorded).toMatchObject({ computer: HERE_PLACE_ID, source: { kind: "folder" } });
    expect(recorded.path).toMatch(/wsp-seed-add-/);
    expect(backend.machines).toEqual([]);
  });
});

describe("the commits a seed carries onto a computer whose git refuses them", () => {
  const withCommits = (folder: string): SeedPlan => plan(folder, { unpushed: { commits: 2, base: "abc123" }, branch: "main", defaultBranch: "main" });
  const KEEPING: SeedChoice = { files: [".env.local"], memory: true, commits: true };

  it("are nought on the record, with git's own last line in the notice and the checkout put back", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: withCommits(folder), projects: "/wsp/projects", keepsImages: false });
    answering(backend, cmd => (cmd.includes("am --3way") ? { exitCode: 128, stdout: "", stderr: "Committer identity unknown\nfatal: empty ident name (for <>) not allowed\n" } : undefined));
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const project = await rt.projects.add({ source: folder, on: "default", name: "seeded-919", seed: KEEPING });
    const lost = "the 2 commits on main did not land on default: fatal: empty ident name (for <>) not allowed; the checkout is on main";
    // The add stands, the record is honest about what is on that computer, and the person is told which.
    expect(project.seeded).toMatchObject({ commits: 0, files: 1 });
    expect(project.notice).toBe(lost);
    // The notice is what the person is told, not a field of the project: the record holds the schema's fields.
    expect((await rt.projects.list())[0]).not.toHaveProperty("notice");
    expect(stages(events).filter(e => e.stage === "seeding").map(e => e.message).at(-1)).toBe(lost);
    // The half applied patch is put back, so every copy of the checkout starts on the clone as it was.
    expect(commands(backend)).toContain("am --abort");
    expect(commands(backend)).toContain("reset --hard origin/main");
  });

  it("are put back on the branch the checkout says it is on, not the branch the plan carried", async () => {
    const folder = repo();
    // The person's own branch, which the remote has never seen, and a plan that names no default branch: the
    // branch to put back cannot be read off either without naming a ref the remote has not got.
    const { rt, backend } = await withImage({ plan: plan(folder, { unpushed: { commits: 1, base: "abc123" }, branch: "refactor/dashboard-polish", defaultBranch: null }), projects: "/wsp/projects", keepsImages: false });
    answering(backend, cmd => {
      if (cmd.includes("symbolic-ref --short HEAD")) return { exitCode: 0, stdout: "main\n", stderr: "" };
      if (cmd.includes("am --3way")) return { exitCode: 128, stdout: "", stderr: "error: could not build fake ancestor\n" };
      return undefined;
    });
    const project = await rt.projects.add({ source: folder, on: "default", name: "seeded-919", seed: KEEPING });
    const ran = commands(backend);
    // The clone came up on main, so that is what the failure road puts back and what the person is told.
    expect(ran).toContain("reset --hard origin/main");
    expect(ran).not.toContain("origin/refactor/dashboard-polish");
    expect(ran).toContain("branch -D refactor/dashboard-polish");
    expect(project.notice).toContain("the checkout is on main");
    expect(project.seeded?.commits).toBe(0);
  });

  it("are the count git read off the checkout, never the number the plan carried", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: withCommits(folder), projects: "/wsp/projects", keepsImages: false });
    // The plan said two; the checkout has one, which is what git answers and what the record keeps.
    answering(backend, cmd => (cmd.includes("am --3way") ? { exitCode: 0, stdout: "1\n", stderr: "" } : undefined));
    const project = await rt.projects.add({ source: folder, on: "default", name: "seeded-919", seed: KEEPING });
    expect(project.seeded?.commits).toBe(1);
    expect(project.notice).toBeUndefined();
    expect(commands(backend)).not.toContain("am --abort");
  });
});
