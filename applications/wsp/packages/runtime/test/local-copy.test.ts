// SPDX-License-Identifier: AGPL-3.0-only
// The computer the app runs on as a computer that makes workspaces: every
// piece of work on a project here, the first included, is a copy of that
// folder at a sibling path, and the person's own folder is never a workspace.
// The copy itself is the daemon binary's, and its rules are proved in the
// daemon's own tests; what is proved here is what the runtime asks for, what
// it records, what a turn on a copy is told, what a delete takes away, and
// what a record of the folder worked in place meets at boot.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCopier, LocalBackend, projectStateKey } from "@wsp/engine";
import { PATH_BOUND_DIR_NAMES } from "@wsp/catalog";
import { copyPathFor, DAEMON_VERSION, EXIT_CODES, exitClassOf, HERE_PLACE_ID, IN_PLACE_ROAD, inPlaceRecordLine, PORT_BASE_FIRST, PORT_BASE_STEP, type AdapterEvent, type TurnResult } from "@wsp/protocol";
import { COPY_SIZE_LINE_BYTES, createRuntime, NO_COPIER_HERE, type HarnessAdapterContext, type HarnessAdapterFactory, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, tempRepo, testPlatform } from "./stub-backend.js";

const roots: string[] = [];
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "wsp-local-copy-"));
  roots.push(root);
  return root;
};
const repos: string[] = [];
const repo = (): string => {
  const at = tempRepo();
  repos.push(at);
  execFileSync("git", ["-C", at, "commit", "-q", "--allow-empty", "-m", "first"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  return at;
};
afterEach(() => {
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
  for (const at of repos.splice(0)) rmSync(at, { recursive: true, force: true });
});

/** What every turn in this file was told, so the environment and the memory key a copy hands its agent can be read
 * back without a real CLI. */
interface Told {
  env: Readonly<Record<string, string>>;
  projectKey: string | undefined;
}

function telling(): { adapter: HarnessAdapterFactory; told: Told[] } {
  const told: Told[] = [];
  const adapter: HarnessAdapterFactory = (ctx: HarnessAdapterContext) => ({
    steers: false,
    start: o => {
      told.push({ env: ctx.env, projectKey: ctx.projectKey });
      const sessionId = "22222222-2222-4222-8222-222222222222";
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = (async () => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) o.onEvent(e);
        return result;
      })();
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, told };
}

/** This computer wired the way a host wires it, with the copy road handed in as the stand-in. */
function withCopier(): { rt: Runtime; copier: ReturnType<typeof fakeCopier>; told: Told[] } {
  const root = scratch();
  const copier = fakeCopier();
  const { adapter, told } = telling();
  const local: LocalWiring = {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier,
  };
  return { rt: createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: adapter }, local }), copier, told };
}

/** This computer wired with no copy road at all, which is a host that found no daemon binary beside itself. */
function withoutCopier(): Runtime {
  const root = scratch();
  const { adapter } = telling();
  const local: LocalWiring = {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
  };
  return createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: adapter }, local });
}

describe("a host with no copy road", () => {
  it("refuses the first workspace of a project here in one sentence naming the road, and records nothing", async () => {
    const rt = withoutCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    await expect(rt.workspaces.create({ project: project.id, name: "one" })).rejects.toMatchObject({ message: NO_COPIER_HERE, kind: "invalid" });
    expect(await rt.workspaces.list()).toEqual([]);
  });
});

describe("every piece of work on a project here, the first included", () => {
  it("is a copy of the folder at a sibling path, asked for with the catalog's path-bound directories and the size line", async () => {
    const { rt, copier } = withCopier();
    const folder = repo();
    const before = statSync(folder).mtimeMs;
    const project = await rt.projects.add({ source: folder });
    const first = await rt.workspaces.create({ project: project.id, name: "pricing page" });
    expect(copier.asks).toEqual([
      { from: folder, to: copyPathFor(folder, "pricing-page"), exclude: [...PATH_BOUND_DIR_NAMES], sizeLineBytes: COPY_SIZE_LINE_BYTES },
    ]);
    expect(first.copy).toEqual({
      road: "clonefile",
      path: copyPathFor(folder, "pricing-page"),
      base: "0".repeat(40),
      branch: "main",
      carried: "deps-and-config",
      source: folder,
    });
    // The workspace's folder is the copy, so a thread on it starts there and not in the person's own checkout,
    // which nothing here wrote.
    expect(first.folder).toBe(copyPathFor(folder, "pricing-page"));
    expect(statSync(folder).mtimeMs).toBe(before);
    expect(execFileSync("git", ["-C", folder, "status", "--porcelain"], { encoding: "utf8" })).toBe("");

    const second = await rt.workspaces.create({ project: project.id, name: "QR codes" });
    expect(copier.asks.map(a => a.to)).toEqual([copyPathFor(folder, "pricing-page"), copyPathFor(folder, "qr-codes")]);
    expect(second.folder).toBe(copyPathFor(folder, "qr-codes"));
  });

  it("carries the branch the project records where it names one", async () => {
    const { rt, copier } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder, base: "release" });
    await rt.workspaces.create({ project: project.id, name: "one" });
    expect(copier.asks[0]!.base).toBe("release");
  });

  it("gets a port base of its own from the first, so two copies on one computer do not both bind 3000", async () => {
    const { rt } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const copyA = await rt.workspaces.create({ project: project.id, name: "one" });
    const copyB = await rt.workspaces.create({ project: project.id, name: "two" });
    expect(copyA.portBase).toBe(PORT_BASE_FIRST);
    expect(copyB.portBase).toBe(PORT_BASE_FIRST + PORT_BASE_STEP);
  });

  it("is where a thread and a command on it start, never the person's own checkout", async () => {
    const { rt } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const first = await rt.workspaces.create({ project: project.id, name: "one" });
    const ran = await rt.workspaces.execStream(first.id, ["pwd"]);
    expect(ran.ranIn).toBe(copyPathFor(folder, "one"));
    expect(ran.ranIn).not.toBe(folder);
    await ran.exited;
  });

  it("tells a turn on it the port to bind and the folder's own memory key", async () => {
    const { rt, told } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const copy = await rt.workspaces.create({ project: project.id, name: "one" });
    await (await rt.sessions.start(copy.id, { prompt: "work" })).finished;
    expect(told[0]!.env["PORT"]).toBe(String(PORT_BASE_FIRST));
    // One memory and one sessions list for the folder and every copy of it: the key is the original folder's.
    expect(told[0]!.projectKey).toBe(projectStateKey("claude", folder));
  });

  it("goes with its record when the workspace is deleted, through the copier, and the person's folder is never named", async () => {
    const { rt, copier } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const first = await rt.workspaces.create({ project: project.id, name: "one" });
    const second = await rt.workspaces.create({ project: project.id, name: "two" });
    await rt.workspaces.delete(second.id);
    expect(copier.removed).toEqual([{ from: folder, to: copyPathFor(folder, "two"), road: "clonefile" }]);
    await rt.workspaces.delete(first.id);
    expect(copier.removed.map(r => r.to)).toEqual([copyPathFor(folder, "two"), copyPathFor(folder, "one")]);
    expect(copier.removed.some(r => r.to === folder)).toBe(false);
    // The base a delete freed is the next copy's, so the numbers stay small.
    const again = await rt.workspaces.create({ project: project.id, name: "three" });
    expect(again.portBase).toBe(PORT_BASE_FIRST);
  });

  it("is refused before the copy runs where a fork's words were named, since the folder is not forked", async () => {
    const { rt, copier } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    await expect(rt.workspaces.create({ project: project.id, name: "one", cpu: 4 })).rejects.toThrow(/takes no --size/);
    expect(copier.asks).toEqual([]);
  });

  it("leaves no copy behind when the record could not be written", async () => {
    const root = scratch();
    const copier = fakeCopier();
    const { adapter } = telling();
    const folder = repo();
    const local: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier,
    };
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter }, local });
    const project = await rt.projects.add({ source: folder });
    // The store goes out from under the create between the copy and the record.
    const broken = store.put;
    store.put = async () => {
      throw new Error("the store is full");
    };
    await expect(rt.workspaces.create({ project: project.id, name: "two" })).rejects.toThrow("the store is full");
    store.put = broken;
    expect(copier.removed).toEqual([{ from: folder, to: copyPathFor(folder, "two"), road: "clonefile" }]);
    // And the name is free again: nothing of the create that failed is held.
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual([]);
  });
});

describe("the daemon beside this host, before the first copy", () => {
  /** This computer wired as a host wires it, with the daemon reader a case names: nothing has dialled the daemon,
   * so the reader is what starts it, which is the road the person who read a usage dump took. */
  function withDaemon(here: { version: number; started: () => void }): { rt: Runtime; copier: ReturnType<typeof fakeCopier> } {
    const root = scratch();
    const copier = fakeCopier();
    const { adapter } = telling();
    const local: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier,
      hereDaemon: {
        version: async () => {
          here.started();
          return here.version;
        },
        fix: "npm i -g @zingzy/wsp",
      },
    };
    return { rt: createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: adapter }, local }), copier };
  }

  it("refuses the copy in one sentence when the binary beside this host is behind, with no usage text anywhere in it", async () => {
    let starts = 0;
    const { rt, copier } = withDaemon({ version: DAEMON_VERSION - 1, started: () => void starts++ });
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    // The first piece of work is a copy, which is where the persona met the binary's own usage as the refusal.
    const refused = await rt.workspaces.create({ project: project.id, name: "one" }).catch((e: unknown) => e as Error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe(`this computer's wsp daemon is version ${DAEMON_VERSION - 1} and this wsp needs ${DAEMON_VERSION}; npm i -g @zingzy/wsp stages the right one`);
    expect((refused as Error).message.toLowerCase()).not.toContain("usage:");
    // A daemon behind this wsp is not a mistyped line and not a name somebody took: it is what the host refused,
    // which is the class an error carrying no kind of its own reads as, and the code a create exits with.
    expect(exitClassOf(refused)).toBe("provider");
    expect(EXIT_CODES[exitClassOf(refused)]).toBe(1);
    // The binary was never run: the read is what the copy waits on, and the read is what started the daemon.
    expect(copier.asks).toEqual([]);
    expect(starts).toBe(1);
  });

  it("makes the copy when the binary answers the version this wsp needs, and makes it on a wiring that reads none", async () => {
    const { rt, copier } = withDaemon({ version: DAEMON_VERSION, started: () => {} });
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    await rt.workspaces.create({ project: project.id, name: "one" });
    expect(copier.asks).toHaveLength(1);

    // A harness that wired no daemon reader at all refuses no copy over it: the reading is the host's to wire, and
    // a test that wires none is not a host running beside a stale binary.
    const bare = withCopier();
    const at = repo();
    const its = await bare.rt.projects.add({ source: at });
    await bare.rt.workspaces.create({ project: its.id, name: "one" });
    expect(bare.copier.asks).toHaveLength(1);
  });
});

describe("a record of the folder worked in place, which no host writes any more", () => {
  it("is not served at boot: the host starts, its other workspaces serve, the record's threads are not listed and the log names the record, the folder and the fix", async () => {
    const root = scratch();
    const copier = fakeCopier();
    const { adapter } = telling();
    const folder = repo();
    const local: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier,
    };
    // A state an older host wrote: the project, the folder itself as its first workspace, a copy beside it, and a
    // thread on each.
    const store = memoryStore();
    const first = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter }, local });
    const project = await first.projects.add({ source: folder });
    const copy = await first.workspaces.create({ project: project.id, name: "two" });
    await (await first.sessions.start(copy.id, { prompt: "on the copy" })).finished;
    await first.close();
    const inPlace = { ...(await store.get("workspaces", copy.id) as Record<string, unknown>), id: "ws_1nplace0", name: "one", copy: { road: IN_PLACE_ROAD, path: folder, source: folder, base: "", branch: "", carried: "nothing" } };
    delete (inPlace as { portBase?: number }).portBase;
    await store.put("workspaces", "ws_1nplace0", inPlace);
    await store.put("sessions", "ws_1nplace0", { workspaceId: "ws_1nplace0", sessions: [{ id: "s_old", workspaceId: "ws_1nplace0", threadId: "t_old", status: "completed", harness: "claude", startedAt: 1, prompt: "in the folder", turnId: "turn_old" }] });

    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(String(line)));
    try {
      const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter }, local });
      expect((await rt.workspaces.list()).map(w => w.id)).toEqual([copy.id]);
      expect((await rt.sessions.list()).map(s => s.workspaceId)).toEqual([copy.id]);
      await expect(rt.workspaces.get("ws_1nplace0")).rejects.toThrow("no such workspace");
      expect(warned).toContain(inPlaceRecordLine("ws_1nplace0", folder));
      // The record is left where it was for the person to move aside: nothing here rewrites their state file.
      expect(await store.get("workspaces", "ws_1nplace0")).toMatchObject({ id: "ws_1nplace0" });
      await rt.close();
    } finally {
      spy.mockRestore();
    }
  });
});
