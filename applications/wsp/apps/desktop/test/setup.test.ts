// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend, NoProviderBackend, type GoldenManifest } from "@wsp/engine";
import { AGENTS_ON, DAEMON_VERSION, HOST_TOKEN_ENV, HOST_URL_ENV, isLocalWorkspace, STATE_SHAPE, type StateShape, type WorkspaceView } from "@wsp/protocol";
import { createRuntime, localExecStream, memoryStore, STATE_SHAPE_KEY, stateWrittenByNewerLine, type LocalWiring, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSsh } from "../../../packages/runtime/test/fake-ssh.js";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { copyingFake, heldAgent } from "../../../packages/host/test/verbs-fixture.js";
import { checkSetup, openThisComputer } from "../src/setup.js";
import { goldenRecipe, makeRuntime, runningWsp, type HereAt, type Keys, type ProviderEnv } from "@wsp/host";

const SOLARI = "slr_live_fake_desktop_key";
const GOLDEN: GoldenManifest = {
  head: 1,
  versions: [
    {
      version: 1,
      snapshotId: "snap_gold",
      baseTemplate: "base",
      setupSha: "x",
      createdAt: "2026-09-01T00:00:00Z",
      smoke: { cmd: "true", exitCode: 0 },
    },
  ],
};

/** A project on this computer and its workspace, which is what a workspace here is: a copy of a folder of the
 * person's own. */
async function here(rt: Runtime, name: string): Promise<WorkspaceView> {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-desktop-")));
  execFileSync("git", ["init", "-q", folder]);
  const project = await rt.projects.add({ source: folder, name });
  return rt.workspaces.create({ project: project.id, name });
}

describe("checkSetup", () => {
  let dir: string;
  let sources: { env: Record<string, string | undefined>; cwd: string; statePath: string };
  const made: { keys: unknown; statePath: string }[] = [];
  /** The store each runtime was handed: the one the first read answered, so the state file is read once. */
  const handed: Store[] = [];
  let store: Store;
  /** One store, read through the provider module a computer with a key wires and the one a computer without it
   * wires, since which onboarding is wanted is read off that module. */
  let keyed: Runtime;
  let keyless: Runtime;

  /** This computer as the window would hold it: a real local backend over a scratch folder, so a local record
   * hydrates rather than being left as a kind this host wired no module for. */
  const localWiring = (root: string): LocalWiring => ({
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({}),
    platform: process.platform === "darwin" ? "darwin" : "linux",
    copier: copyingFake(),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-desktop-setup-"));
    mkdirSync(join(dir, "cwd"));
    sources = { env: {}, cwd: join(dir, "cwd"), statePath: join(dir, "state.json") };
    made.length = 0;
    handed.length = 0;
    store = memoryStore();
    const wiring = { store, adapters: {}, local: localWiring(join(dir, "user")), ssh: fakeSsh().wiring, hostId: "box:h1" };
    keyed = createRuntime({ backend: stubBackend(), ...wiring });
    keyless = createRuntime({ backend: new NoProviderBackend(), ...wiring });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** What makeRuntime does with what it is handed: the provider module the environment the keys were read through
   * names, and behind no provider key the one that holds no machine. */
  const runtimeFor = (keys: Keys, statePath: string, env: ProviderEnv, store: Store): Runtime => {
    made.push({ keys, statePath });
    handed.push(store);
    return (env["SOLARI_API_KEY"] ?? "") === "" ? keyless : keyed;
  };

  it("is not ready, with nothing asked, when there is no key and nothing to show either", async () => {
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false });
    // A missing provider key is not a missing answer: the state was read anyway, with no key handed to the runtime.
    expect(made).toEqual([{ keys: {}, statePath: join(dir, "state.json") }]);
    // And the runtime was handed the store that read answered, so nothing reads the file a second time.
    expect(await handed[0]!.keys("workspaces")).toEqual([]);
  });

  it("opens on a computer with no provider key whose state holds this computer", async () => {
    await here(keyless, "thisbox");
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: true, runtime: keyless });
  });

  it("carries the Claude key on that road, since a thread here uses it as a fork would", async () => {
    sources.env = { ANTHROPIC_API_KEY: "sk-ant-x-fake-desktop-key" };
    await here(keyless, "thisbox");
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: true, runtime: keyless });
    expect(made).toEqual([{ keys: { anthropic: "sk-ant-x-fake-desktop-key" }, statePath: join(dir, "state.json") }]);
  });

  it("is not ready when the key exists but the store has no golden and no workspace", async () => {
    sources.env = { SOLARI_API_KEY: SOLARI };
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false });
    // The provider key is not among the keys the runtime is handed: it rides in the environment it picks from.
    expect(made).toEqual([{ keys: {}, statePath: join(dir, "state.json") }]);
  });

  it("is not ready when the manifest has no head version", async () => {
    sources.env = { SOLARI_API_KEY: SOLARI };
    await store.put("goldens", "default", { ...GOLDEN, head: 2 });
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false });
  });

  it("closes a runtime built past the read when the launch is refused after it", async () => {
    const closed = vi.spyOn(keyless, "close");
    vi.spyOn(keyless.golden, "get").mockRejectedValue(new Error("refused past the first read"));
    await expect(checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).rejects.toThrow("refused past the first read");
    expect(closed).toHaveBeenCalled();
  });

  it("is ready with a key and a golden, handing back the runtime it built", async () => {
    sources.env = { SOLARI_API_KEY: SOLARI };
    await store.put("goldens", "default", GOLDEN);
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: true, runtime: keyed });
  });

  it("builds the runtime a thread on this computer gets its own token from, at the loopback the host fills in", async () => {
    const held = heldAgent(false);
    const here: HereAt = {};
    const run = { ...runningWsp(), shim: join(dir, "bin", "wsp") };
    let built: Runtime | undefined;
    const opened = await openThisComputer({
      statePath: join(dir, "state.json"),
      sources,
      agents: { here, run },
      // The real build with what the window hands it, and a stand-in agent where a real one would start a process.
      runtimeFor: (keys, statePath, env, over, agents) =>
        (built = makeRuntime(keys, statePath, goldenRecipe(), env, agents, localWiring(join(dir, "user")), undefined, over, { claude: held.adapter })),
    });
    expect(opened.runtime).toBe(built);
    const rt = opened.runtime;
    try {
      const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-desktop-")));
      execFileSync("git", ["init", "-q", folder]);
      const project = await rt.projects.add({ source: folder, name: "mine" });
      const mac = await rt.workspaces.create({ project: project.id, name: "mine", agents: AGENTS_ON });
      here.url = "http://127.0.0.1:4801";
      const turn = await rt.sessions.start(mac.id, { prompt: "hi" });
      expect(held.envs[0]![HOST_URL_ENV]).toBe("http://127.0.0.1:4801");
      expect(held.envs[0]![HOST_TOKEN_ENV]).toMatch(/\S/);
      expect((await rt.devices.list()).map(d => d.scope?.workspaceId)).toEqual([mac.id]);
      held.release(0, "done");
      await turn.finished;
    } finally {
      await rt.close();
    }
  });

  describe("openThisComputer", () => {
    it("records nothing: a workspace is one project's copy, so a first launch hands back the runtime and no workspace", async () => {
      const opened = await openThisComputer({ statePath: join(dir, "state.json"), sources, runtimeFor });
      expect(opened.runtime).toBe(keyless);
      expect(opened.workspace).toBeNull();
      expect(await keyless.workspaces.list()).toEqual([]);
      // Nothing was made, so the state still has nothing to show and the next launch opens on the same screen.
      expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false });
    });

    it("hands back the workspace on this computer where one already stands", async () => {
      const first = await here(keyless, "thisbox");
      const opened = await openThisComputer({ statePath: join(dir, "state.json"), sources, runtimeFor });
      expect(opened.workspace!.id).toBe(first.id);
      expect(isLocalWorkspace(opened.workspace!)).toBe(true);
      expect(await keyless.workspaces.list()).toHaveLength(1);
    });

    it("takes the same road with a provider key and no golden", async () => {
      sources.env = { SOLARI_API_KEY: SOLARI };
      const opened = await openThisComputer({ statePath: join(dir, "state.json"), sources, runtimeFor });
      expect(opened.runtime).toBe(keyed);
      expect(opened.workspace).toBeNull();
    });
  });

  describe("a state file a newer wsp wrote", () => {
    const wrote: StateShape = { shape: STATE_SHAPE + 1, wsp: "9.9.9", daemon: DAEMON_VERSION + 1, bin: "/Applications/wsp.app/Contents/Resources/bin.js", at: "2026-09-19T05:00:00.000Z" };
    let state: string;

    beforeEach(() => {
      state = join(dir, "state", "state.json");
      mkdirSync(join(dir, "state"));
      writeFileSync(state, JSON.stringify({ workspaces: {}, [STATE_SHAPE_KEY]: wrote }));
      sources.statePath = state;
      // The window's own road, with no runtime handed in: an older app opened on a newer state builds what it
      // would build, and this computer's own folders are the scratch dir's rather than the person's.
      vi.stubEnv("HOME", join(dir, "user"));
      vi.stubEnv("WSP_HOME", join(dir, "state"));
    });
    afterEach(() => vi.unstubAllEnvs());

    it("checkSetup refuses it and mints nothing: the wiring writes this host's key beside the state on its first read", async () => {
      await expect(checkSetup({ statePath: state, sources })).rejects.toThrow(stateWrittenByNewerLine(state, wrote));
      expect(readdirSync(join(dir, "state"))).toEqual(["state.json"]);
    });

    it("refuses before the runtime is made at all, so nothing it would have started is running", async () => {
      await expect(checkSetup({ statePath: state, sources, runtimeFor })).rejects.toThrow(stateWrittenByNewerLine(state, wrote));
      expect(made).toEqual([]);
    });

    it("openThisComputer refuses it the same way, with nothing written beside the state", async () => {
      await expect(openThisComputer({ statePath: state, sources })).rejects.toThrow(stateWrittenByNewerLine(state, wrote));
      expect(readdirSync(join(dir, "state"))).toEqual(["state.json"]);
    });
  });
});
