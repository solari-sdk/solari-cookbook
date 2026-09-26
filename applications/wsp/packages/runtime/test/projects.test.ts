// SPDX-License-Identifier: AGPL-3.0-only
// Projects as records of their own: what wsp add records and what it refuses,
// the two roads a workspace of one takes, and what a thread on it starts in.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyPathFor, gitOnThisMacRefusal, HERE_PLACE_ID, NO_IMAGE_FOR_SEED, noRemoteLine, copyTakesNone, idPrefixRefusal, noWorkspaceRefusal, NOT_A_REPO_LINE, projectInUseRefusal, sameSourceRefusal, seedChoiceNeeded, type AdapterEvent, type EventUnion, type SeedPlan, type TurnResult } from "@wsp/protocol";
import { createRuntime, NO_SEED_WIRING, type HarnessAdapterFactory, type HarnessStartOptions, type Runtime, type SeedWiring } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, fakeLocal, projectOn, stubBackend, tempRepo, type StubBackend, type StubMachine } from "./stub-backend.js";

const REPO = "https://github.com/spoo-me/frontend.git";

/** A harness that records what it was started with and replies at once. */
function recording(): { adapter: HarnessAdapterFactory; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  let n = 0;
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      starts.push(o);
      const sessionId = o.resume ?? `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = (async () => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId, model: "claude-sonnet-4-5" },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) o.onEvent(e);
        return result;
      })();
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

const roots: string[] = [];
const here = (): string => {
  const root = mkdtempSync(join(tmpdir(), "wsp-projects-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function withLocal(backend: StubBackend = stubBackend(), seed?: SeedWiring): { rt: Runtime; backend: StubBackend; starts: HarnessStartOptions[] } {
  const { adapter, starts } = recording();
  const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: adapter }, local: fakeLocal(here()), ...(seed !== undefined ? { seed } : {}) });
  return { rt, backend, starts };
}

/** What the host's own reader would answer for a folder here, as a test hands it in: the menu is the collector's
 * and is proved there, so these cases hand in one plan and watch what the add does with it. */
function seedPlanFor(folder: string): SeedPlan {
  return {
    source: folder,
    remote: REPO,
    branch: "main",
    defaultBranch: "main",
    unpushed: null,
    uncommitted: 0,
    memory: null,
    files: [{ path: ".env.local", dir: false, bytes: 4096, kind: "config", row: { id: "next", name: "Next" }, ticked: true }],
    remembered: false,
  };
}

describe("recording a project", () => {
  it("a folder that is a git repo is a project on this computer, in place, and it goes out as an event", async () => {
    const { rt } = withLocal();
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const folder = tempRepo();
    const project = await rt.projects.add({ source: folder });
    expect(project).toMatchObject({ id: expect.stringMatching(/^pr_[0-9a-f]{8}$/), name: folder.split("/").at(-1), computer: HERE_PLACE_ID, path: folder, source: { kind: "folder", path: folder } });
    expect(events.filter(e => e.type === "project.added")).toEqual([{ type: "project.added", project, seq: expect.any(Number) }]);
    expect(await rt.projects.list()).toEqual([project]);
    rmSync(folder, { recursive: true, force: true });
  });

  it("a folder that is no git repo is no project: a workspace of one starts on a branch", async () => {
    const { rt } = withLocal();
    const plain = mkdtempSync(join(tmpdir(), "wsp-plain-"));
    await expect(rt.projects.add({ source: plain })).rejects.toThrow(NOT_A_REPO_LINE);
    expect(await rt.projects.list()).toEqual([]);
    rmSync(plain, { recursive: true, force: true });
  });

  it("a folder under a repo is no project either: the folder itself has to be the top of it", async () => {
    const { rt } = withLocal();
    const repo = tempRepo();
    execFileSync("mkdir", ["-p", join(repo, "packages", "host")]);
    await expect(rt.projects.add({ source: join(repo, "packages", "host") })).rejects.toThrow(NOT_A_REPO_LINE);
    rmSync(repo, { recursive: true, force: true });
  });

  it("a repo's url with no computer names the ones that clone, since this computer takes a folder of yours", async () => {
    const { rt } = withLocal();
    await expect(rt.projects.add({ source: REPO })).rejects.toThrow("name the computer that clones it with --on default");
    expect(await rt.projects.list()).toEqual([]);
  });

  it("a repo's url on a computer that clones records the clone's own path inside a copy of it", async () => {
    const { rt } = withLocal();
    const project = await rt.projects.add({ source: REPO, on: "default", name: "spoo-landing" });
    expect(project).toMatchObject({ computer: "default", name: "spoo-landing", path: "/root/spoo-landing", source: { kind: "git", url: REPO } });
    // The same source on that computer again is the same project, so a second record of it is refused by name.
    await expect(rt.projects.add({ source: REPO, on: "default" })).rejects.toMatchObject({ message: sameSourceRefusal("spoo-landing", "default"), kind: "conflict" });
  });

  it("a repo's url on this computer is refused: it works the folder you already have", async () => {
    const { rt } = withLocal();
    await expect(rt.projects.add({ source: REPO, on: HERE_PLACE_ID })).rejects.toThrow(gitOnThisMacRefusal);
  });

  it("a folder seeding a computer that clones is refused until the person has said what travels", async () => {
    const folder = tempRepo();
    const plan = seedPlanFor(folder);
    const { rt } = withLocal(stubBackend(), { plan: async () => plan, pack: async () => ({ tar: Buffer.from("x"), files: 1, bytes: 1, commits: 0, left: [] }) });
    await expect(rt.projects.add({ source: folder, on: "default" })).rejects.toThrow(seedChoiceNeeded(folder));
    expect(await rt.projects.list()).toEqual([]);
    rmSync(folder, { recursive: true, force: true });
  });

  it("a folder seeding a computer this host has sealed no image for is refused: the seed has nowhere to land", async () => {
    const folder = tempRepo();
    const plan = seedPlanFor(folder);
    const { rt } = withLocal(stubBackend(), { plan: async () => plan, pack: async () => ({ tar: Buffer.from("x"), files: 1, bytes: 1, commits: 0, left: [] }) });
    await expect(rt.projects.add({ source: folder, on: "default", seed: { files: [], memory: false, commits: false } })).rejects.toThrow(NO_IMAGE_FOR_SEED);
    rmSync(folder, { recursive: true, force: true });
  });

  it("a folder with no remote cannot seed a computer that clones: there is nothing for it to clone", async () => {
    const folder = tempRepo();
    const plan = { ...seedPlanFor(folder), remote: null };
    const { rt } = withLocal(stubBackend(), { plan: async () => plan, pack: async () => ({ tar: Buffer.from("x"), files: 1, bytes: 1, commits: 0, left: [] }) });
    await expect(rt.projects.add({ source: folder, on: "default", seed: { files: [], memory: false, commits: false } })).rejects.toThrow(noRemoteLine(folder));
    rmSync(folder, { recursive: true, force: true });
  });

  it("a runtime the host wired no folder reader into records a folder here and refuses to seed one elsewhere", async () => {
    const { rt } = withLocal();
    const folder = tempRepo();
    expect(await rt.projects.add({ source: folder })).toMatchObject({ path: folder });
    const second = tempRepo();
    await expect(rt.projects.add({ source: second, on: "default" })).rejects.toThrow(NO_SEED_WIRING);
    for (const dir of [folder, second]) rmSync(dir, { recursive: true, force: true });
  });

  it("a project is dropped once no workspace stands on it, and the drop goes out as an event", async () => {
    const { rt } = withLocal();
    const events: EventUnion[] = [];
    const project = await projectOn(rt);
    const ws = await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" });
    rt.events.on("*", e => events.push(e));
    await expect(rt.projects.remove(project.id)).rejects.toMatchObject({ message: projectInUseRefusal(project.name, ["work"]), kind: "conflict" });
    await rt.workspaces.delete(ws.id);
    await rt.projects.remove(project.id);
    expect(await rt.projects.list()).toEqual([]);
    expect(events.filter(e => e.type === "project.removed")).toEqual([{ type: "project.removed", projectId: project.id, seq: expect.any(Number) }]);
  });

  it("a project is named by id or by name, and a word that names none is refused with the ones there are", async () => {
    const { rt } = withLocal();
    const project = await projectOn(rt, "default", REPO, { name: "spoo-landing" });
    expect(await rt.projects.resolve(project.id)).toEqual(project);
    expect(await rt.projects.resolve("spoo-landing")).toEqual(project);
    await expect(rt.projects.resolve("nothing")).rejects.toThrow("no project \"nothing\"; this host holds spoo-landing");
  });
});

describe("a workspace of a project", () => {
  it("on a computer that clones, it forks that computer's image and clones the repo into it before it is ready", async () => {
    const { rt, backend } = withLocal();
    const stages: string[] = [];
    rt.events.on("*", e => {
      if (e.type === "workspace.creating") stages.push(e.stage);
    });
    const project = await rt.projects.add({ source: REPO, on: "default", name: "spoo-landing", base: "main" });
    const ws = await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "pricing page" });
    expect(ws.project).toEqual({ id: project.id, name: "spoo-landing", path: "/root/spoo-landing", computer: "default" });
    // The clone is a script now: the folder above the checkout is made first, and a source cloned through a host's
    // own command line checks that command is there. The line itself is still git's.
    expect(backend.machines[0]!.execLog.join("\n")).toContain(`git clone --branch main ${REPO} /root/spoo-landing`);
    expect(stages).toContain("project-cloned");
    expect(stages.indexOf("project-cloned")).toBeLessThan(stages.indexOf("ready"));
  });

  it("with no base recorded the clone takes the remote's own default branch", async () => {
    const { rt, backend } = withLocal();
    const project = await rt.projects.add({ source: REPO, on: "default", name: "spoo-landing" });
    await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" });
    expect(backend.machines[0]!.execLog.join("\n")).toContain(`git clone ${REPO} /root/spoo-landing`);
  });

  it("a clone that fails ends the create with git's own last line and the machine goes with it", async () => {
    const backend = stubBackend();
    const plain = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd.includes("git clone") ? { exitCode: 128, stdout: "", stderr: "Cloning into '/root/x'...\nfatal: could not read Username for 'https://github.com'" } : plain(m, cmd));
    const { rt } = withLocal(backend);
    const project = await rt.projects.add({ source: REPO, on: "default", name: "x" });
    await expect(rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" })).rejects.toThrow("fatal: could not read Username for 'https://github.com'");
    expect(backend.machines.every(m => m.killed)).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("a fork whose clone fails is gone from the provider even when the first delete does not take, and nothing is recorded", async () => {
    const backend = stubBackend();
    const plain = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd.includes("git clone") ? { exitCode: 128, stdout: "", stderr: "fatal: destination path '/root/x' already exists and is not an empty directory" } : plain(m, cmd));
    // A provider that answers the delete and keeps the machine, which is what left failed forks running on the
    // account: the second ask is what takes it away, so the road has to read the provider rather than the answer.
    const made = backend.create.bind(backend);
    backend.create = async spec => {
      const m = (await made(spec)) as StubMachine;
      const kill = m.kill.bind(m);
      let asked = 0;
      m.kill = async () => {
        if (++asked > 1) await kill();
      };
      return m;
    };
    const { adapter } = recording();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: adapter }, local: fakeLocal(here()), killConfirm: { graceMs: 20, pollMs: 1 } });
    const project = await rt.projects.add({ source: REPO, on: "default", name: "x" });
    await expect(rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" })).rejects.toThrow("already exists and is not an empty directory");
    expect(await backend.list()).toEqual([]);
    expect(backend.machines.every(m => m.killed)).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("a fork whose clone fails and whose machine the provider never parts with keeps a record naming that machine", async () => {
    const backend = stubBackend();
    const plain = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd.includes("git clone") ? { exitCode: 128, stdout: "", stderr: "fatal: destination path '/root/x' already exists and is not an empty directory" } : plain(m, cmd));
    // A provider that answers every delete and keeps the machine running whatever is read back: the record is all
    // that is left naming it, so it stays, since a machine nobody records bills unseen.
    const made = backend.create.bind(backend);
    backend.create = async spec => {
      const m = (await made(spec)) as StubMachine;
      m.kill = async () => {};
      return m;
    };
    const { adapter } = recording();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: adapter }, local: fakeLocal(here()), killConfirm: { graceMs: 20, pollMs: 1 } });
    const project = await rt.projects.add({ source: REPO, on: "default", name: "x" });
    await expect(rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" })).rejects.toThrow("already exists and is not an empty directory");
    const kept = await rt.workspaces.list();
    expect(kept.map(w => w.name)).toEqual(["work"]);
    expect((await backend.list()).map(m => m.id)).toEqual([kept[0]!.machineId]);
  });

  it("takes none of the words a fork takes: the folder is the workspace, so from, size and engine are refused in one sentence", async () => {
    const { rt } = withLocal();
    const folder = tempRepo();
    const project = await rt.projects.add({ source: folder });
    for (const [asked, word] of [
      [{ golden: "snap_g" }, "--from"],
      [{ cpu: 2, memMb: 4096 }, "--size"],
      [{ engine: true }, "--engine"],
    ] as const) {
      await expect(rt.workspaces.create({ project: project.id, name: "work", ...asked })).rejects.toThrow(copyTakesNone(project.name, [word]));
    }
    // Nothing was recorded by any of the three: the refusal comes before the record.
    expect(await rt.workspaces.list()).toEqual([]);
    rmSync(folder, { recursive: true, force: true });
  });

  it("on this computer the first workspace is a copy of the folder at a sibling path, with a port of its own", async () => {
    const { rt } = withLocal();
    const folder = tempRepo();
    const project = await rt.projects.add({ source: folder });
    const ws = await rt.workspaces.create({ project: project.id, name: "plan check" });
    expect(ws).toMatchObject({ kind: "local", golden: "", project: { name: project.name, path: folder, computer: HERE_PLACE_ID } });
    expect(ws.copy).toMatchObject({ road: "clonefile", path: copyPathFor(folder, "plan-check"), source: folder });
    expect(ws.folder).toBe(copyPathFor(folder, "plan-check"));
    // A copy binds a port of its own, since two copies on one computer cannot both have 3000.
    expect(ws.portBase).toBeDefined();
    // A host with no copy road makes none at all; that is local-copy.test.ts.
    rmSync(folder, { recursive: true, force: true });
  });
});

describe("a project recorded before a later build's fields", () => {
  /** A record as yesterday's host wrote it: the four fields this build added are not on it. */
  const old = { id: "pr_old", name: "spoo-landing", computer: "default", source: { kind: "git" as const, url: REPO }, path: "/root/spoo-landing", createdAt: "2026-09-16T00:00:00.000Z" };

  it("is filled in at load with the add's own rules and written back, not refused", async () => {
    const store = memoryStore();
    await store.put("projects", old.id, old);
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {}, local: fakeLocal(here()) });
    const [project] = await rt.projects.list();
    expect(project).toMatchObject({
      id: "pr_old",
      remote: REPO,
      defaultBranch: "main",
      memoryKey: "-root-spoo-landing",
      memoryDir: "/root/.claude-cfg/projects/-root-spoo-landing/memory",
    });
    // Written back, so the next boot reads a record that carries them.
    expect(await store.get("projects", "pr_old")).toEqual(project);
    // And the workspaces standing on it still stand: nothing asked anybody to move a state file aside.
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("on a computer that holds the checkout, carries the memory folder that computer's own road names", async () => {
    const store = memoryStore();
    await store.put("projects", old.id, old);
    const backend = stubBackend();
    // What the computer says about itself: it keeps the project checkouts on a disk of its own and no image.
    (backend as { projects?: string }).projects = "/wsp/projects";
    backend.capabilities.images = false;
    const rt = createRuntime({ backend, store, adapters: {}, local: fakeLocal(here()) });
    const [project] = await rt.projects.list();
    // The road's own rule: the agent's own state home on that computer, which every workspace of it reads from
    // the computer itself, so nothing of wsp's is mounted over that home.
    expect(project?.memoryDir).toBe(`/root/.claude-cfg/projects/${project?.memoryKey}/memory`);
    // What a workspace of a project on such a computer mounts is proved in project-landing.test.ts, on a record
    // the add cloned a checkout for. A record with none, which is this one, is refused a workspace there instead,
    // since nothing clones one at a create any more.
    await expect(rt.workspaces.create({ project: old.id, name: "work" })).rejects.toThrow("was recorded before a project was cloned once on its computer");
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("keeps every field a record already carries, and reads a folder here against this computer's own store", async () => {
    const store = memoryStore();
    const folder = tempRepo();
    await store.put("projects", "pr_here", { ...old, id: "pr_here", computer: HERE_PLACE_ID, source: { kind: "folder", path: folder }, path: folder, remote: "git@github.com:dev/x.git" });
    const root = here();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {}, local: fakeLocal(root) });
    const [project] = await rt.projects.list();
    // The remote it was recorded with stands; the key and the folder are this computer's own reading.
    expect(project?.remote).toBe("git@github.com:dev/x.git");
    expect(project?.memoryKey).toBe(folder.replace(/[^A-Za-z0-9]/g, "-"));
    expect(project?.memoryDir).toContain("/projects/");
    expect(project?.memoryDir.endsWith("/memory")).toBe(true);
    rmSync(folder, { recursive: true, force: true });
  });
});

describe("naming a workspace", () => {
  /** Two workspaces whose ids share their first six characters, written into the store by hand: the runtime mints
   * random ids, and an ambiguous prefix is only ambiguous where two ids are known to share one. */
  function twoSharing(): Runtime {
    const store = memoryStore();
    const project = {
      id: "pr_1",
      name: "spoo-landing",
      computer: "default",
      source: { kind: "git" as const, url: REPO },
      path: "/root/spoo-landing",
      remote: REPO,
      defaultBranch: "main",
      memoryKey: "-root-spoo-landing",
      memoryDir: "/root/.claude-cfg/projects/-root-spoo-landing/memory",
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    void store.put("projects", project.id, project);
    for (const [id, name] of [["ws_1a2b3c4d", "pricing page"], ["ws_1a2bffff", "landing copy"]] as const) {
      void store.put("workspaces", id, { id, name, kind: "cloud", project: project.id, machineId: `m_${id}`, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00.000Z", spec: {}, size: { cpu: 2, memMb: 4096 }, firstLife: true });
    }
    return createRuntime({ backend: stubBackend(), store, adapters: {} });
  }

  it("takes the id, the name, or enough of the id to name one", async () => {
    const rt = twoSharing();
    expect((await rt.workspaces.resolve("ws_1a2b3c4d")).name).toBe("pricing page");
    expect((await rt.workspaces.resolve("pricing page")).id).toBe("ws_1a2b3c4d");
    // Enough of an id is the way round quoting a name with spaces.
    expect((await rt.workspaces.resolve("ws_1a2b3")).name).toBe("pricing page");
    expect((await rt.workspaces.resolve("ws_1a2bf")).name).toBe("landing copy");
  });

  it("refuses a word that starts two of them with both ids, and one too short to name any as absent", async () => {
    const rt = twoSharing();
    await expect(rt.workspaces.resolve("ws_1a2b")).rejects.toThrow(idPrefixRefusal("ws_1a2b", ["ws_1a2b3c4d", "ws_1a2bffff"]));
    // Three characters is under the floor, so it is read as a name and nothing else, however many ids open with it.
    await expect(rt.workspaces.resolve("ws_")).rejects.toThrow(noWorkspaceRefusal("ws_"));
  });

  it("a workspace whose name is the start of two ids is its name, since a whole word wins over a prefix", async () => {
    const rt = twoSharing();
    const project = (await rt.projects.list())[0]!;
    // The name is exactly the word that starts both ids: a person who named a workspace that cannot be locked out
    // of it by two ids that happen to share those characters.
    const named = await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "ws_1a2b" });
    expect((await rt.workspaces.resolve("ws_1a2b")).id).toBe(named.id);
    // The two ids are still ambiguous under any other word that starts both and names no workspace.
    await expect(rt.workspaces.resolve("ws_1a2b3c4d5")).rejects.toThrow(noWorkspaceRefusal("ws_1a2b3c4d5"));
  });
});

describe("the folder a thread starts in", () => {
  it("is the workspace's project, and the cwd a caller names wins over it", async () => {
    const { rt, starts } = withLocal();
    const project = await rt.projects.add({ source: REPO, on: "default", name: "spoo-landing" });
    const ws = await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" });
    await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(starts.at(-1)!.cwd).toBe("/root/spoo-landing");
    await rt.sessions.start(ws.id, { prompt: "hi", cwd: "/root/elsewhere" });
    expect(starts.at(-1)!.cwd).toBe("/root/elsewhere");
  });

  it("the agent a thread ran under is remembered on the project and taken by the next thread that names none", async () => {
    const { rt } = withLocal();
    const project = await projectOn(rt);
    const ws = await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" });
    expect((await rt.projects.resolve(project.id)).lastAgent).toBeUndefined();
    await rt.sessions.start(ws.id, { prompt: "hi", harness: "claude" });
    expect((await rt.projects.resolve(project.id)).lastAgent).toBe("claude");
    // A start that names none runs it, which is what the composer and the command line both show as the default.
    const handle = await rt.sessions.start(ws.id, { prompt: "again" });
    expect(handle.view().harness).toBe("claude");
  });

  it("the last target is the workspace alone, since a workspace holds one project", async () => {
    const { rt } = withLocal();
    const project = await projectOn(rt);
    const ws = await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" });
    await rt.sessions.start(ws.id, { prompt: "hi" });
    expect((await rt.preferences.get()).target).toEqual({ workspace: ws.id });
  });
});

describe("a state file from before projects were records", () => {
  it("is not read: the host refuses in one sentence naming the file and does not serve", async () => {
    const store = memoryStore();
    await store.put("workspaces", "ws_old", { id: "ws_old", name: "old", kind: "cloud", machineId: "m1", phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00.000Z", spec: {}, size: { cpu: 2, memMb: 4096 }, firstLife: true, projects: [{ name: "spoo", dest: "/root/spoo", importedAt: "2026-09-01T00:00:00.000Z" }] });
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {}, statePath: "/tmp/wsp-hierarchy/state.json" });
    await expect(rt.workspaces.list()).rejects.toThrow("move /tmp/wsp-hierarchy/state.json aside and start again");
  });
});
