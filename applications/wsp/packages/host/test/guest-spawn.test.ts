// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command a turn's own agent runs on its machine, driven by nothing
// but the address and the token its launch left in the environment, against
// the host that launched it: the road a thread takes to fork a machine, the
// cap that stops the third, and the state file on this computer left unread.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE_PLACE_ID, HOST_TOKEN_ENV, HOST_URL_ENV, LOOPBACK, spawnCapRefusal, type ThreadView, type WorkspaceView } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, localWiring, serve } from "../src/cli.js";
import { hostReach } from "../src/pairing.js";
import type { HostHandle } from "../src/server.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";
import { PAGE, captured, copyingFake, fakeDaemonStart, heldAgent, type Captured } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

describe("the wsp command on a thread's machine", () => {
  let dir: string;
  let statePath: string;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  let held: ReturnType<typeof heldAgent>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-guest-spawn-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_guest_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
    held = heldAgent(false);
    // The address a machine dials this host at is the port the host is about to bind, so the launch carries the
    // very address the command below dials.
    let advertised = "";
    rt = createRuntime({
      backend: stubBackend(),
      store,
      adapters: { claude: held.adapter },
      local: localWiring(join(dir, "user")),
      agents: {
        reach: {
          get url() {
            return advertised;
          },
        },
        wspMcp: { command: "node", args: ["/root/wsp-daemon/wsp/dist/bin.js", "mcp"] },
      },
    });
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    advertised = `http://127.0.0.1:${handle.port}`;
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A line as the person types it on this computer: no pair in the environment, the served state file its host. */
  async function person(...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    return { code: await cli([...argv, "--state", statePath], io, undefined, {}), io };
  }
  /** The same line run by the turn's agent on its machine, with the environment the launch handed it and nothing of
   * this computer's: no --state, no hosts folder, a home of its own. */
  async function guest(env: Readonly<Record<string, string>>, ...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    return { code: await cli(argv, io, undefined, { ...env, HOME: join(dir, "guest"), WSP_HOME: join(dir, "guest", ".wsp") }), io };
  }
  const json = <T>(io: Captured): T => JSON.parse(io.lines.at(-1)!) as T;

  it("forks through wsp new with the launch's own token, under its root, and the cap refuses the third", async () => {
    await rt.projects.add({ source: "https://github.com/dev/one.git", on: "default" });
    expect((await person("new", "one", "--spawn", "on", "--max-machines", "2")).code).toBe(0);
    const [one] = await rt.workspaces.list();
    const turn = await rt.sessions.start(one!.id, { prompt: "fork two machines" });
    const threadId = turn.view().threadId!;
    const launch = held.envs[0]!;
    expect(launch[HOST_URL_ENV]).toBe(`http://127.0.0.1:${handle!.port}`);
    const pair = { [HOST_URL_ENV]: launch[HOST_URL_ENV]!, [HOST_TOKEN_ENV]: launch[HOST_TOKEN_ENV]! };

    const f1 = await guest(pair, "new", "f1", "--json");
    expect(f1.io.errors).toEqual([]);
    expect(f1.code).toBe(0);
    const f2 = await guest(pair, "new", "f2");
    expect(f2.code).toBe(0);
    expect(f2.io.lines.at(-1)).toMatch(/^created f2 ws_/);
    // Both stand under the thread that asked, which is what the cap counts and what the tree draws.
    const forks = (await rt.workspaces.list()).filter(w => w.name.startsWith("f"));
    expect(forks.map(w => w.rootThreadId)).toEqual([threadId, threadId]);
    expect(forks.map(w => w.parentThreadId)).toEqual([threadId, threadId]);

    const f3 = await guest(pair, "new", "f3");
    expect(f3.code).not.toBe(0);
    expect(f3.io.errors[0]).toContain(spawnCapRefusal(threadId, 2, 2));
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["f1", "f2", "one"]);

    // The listing the agent reads is its own tree, over the same token, with the state file on this computer never
    // opened: a person's line on the same state file with no pair in its environment is still the person's.
    const seen = json<{ workspaces: WorkspaceView[] }>((await guest(pair, "workspaces", "--json")).io);
    expect(seen.workspaces.map(w => w.name).sort()).toEqual(["f1", "f2", "one"]);
    expect((await person("workspaces", "agents", "one", "--spawn", "off")).code).toBe(0);
    held.release(0, "done");
    await turn.finished;
  });
});

describe("the wsp command a thread on this computer runs", () => {
  let dir: string;
  let statePath: string;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  let held: ReturnType<typeof heldAgent>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-mac-spawn-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    held = heldAgent(false);
    // The loopback address is the host's to fill once its socket binds, and the runtime reads it at each launch
    // through the same reach a real host hands it.
    const here: { url?: string } = {};
    rt = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: { claude: held.adapter },
      local: localWiring(join(dir, "user"), process.env, fakeDaemonStart, undefined, copyingFake()),
      agents: { reach: hostReach({ address: LOOPBACK, port: 0 }, undefined, () => undefined, undefined, here), wspMcp: { command: "wsp", args: ["mcp"] } },
    });
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt, here });
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function person(...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    return { code: await cli([...argv, "--state", statePath], io, undefined, {}), io };
  }
  /** The line the thread's agent runs, carrying the launch pair and nothing else of the host's. */
  async function thread(env: Readonly<Record<string, string>>, ...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    return { code: await cli(argv, io, undefined, { ...env, HOME: join(dir, "agent"), WSP_HOME: join(dir, "agent", ".wsp") }), io };
  }
  const json = <T>(io: Captured): T => JSON.parse(io.lines.at(-1)!) as T;

  it("a thread started here runs wsp new and wsp run with the launch pair alone, and both children nest under it", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    const project = await rt.projects.add({ source: repo, on: HERE_PLACE_ID });
    expect((await person("new", project.name, "mac", "--spawn", "on")).code).toBe(0);
    expect((await person("new", project.name, "other")).code).toBe(0);
    const byName = async (name: string): Promise<WorkspaceView> => (await rt.workspaces.list()).find(w => w.name === name)!;
    // The person's own thread on another copy, which no thread of the Mac's tree may see.
    const theirs = await rt.sessions.start((await byName("other")).id, { prompt: "the person's own" });
    const lead = await rt.sessions.start((await byName("mac")).id, { prompt: "start two children" });
    const threadId = lead.view().threadId!;
    const launch = held.envs[1]!;
    expect(launch[HOST_URL_ENV]).toBe(`http://${LOOPBACK}:${handle!.wsPort}`);
    const pair = { [HOST_URL_ENV]: launch[HOST_URL_ENV]!, [HOST_TOKEN_ENV]: launch[HOST_TOKEN_ENV]! };

    const made = await thread(pair, "new", "kid", "--json");
    expect(made.io.errors).toEqual([]);
    expect(made.code).toBe(0);
    expect(await byName("kid")).toMatchObject({ kind: "local", parentThreadId: threadId, rootThreadId: threadId });

    const ran = await thread(pair, "run", "kid", "--detach", "look around", "--json");
    expect(ran.io.errors).toEqual([]);
    expect(ran.code).toBe(0);
    const child = json<{ threadId: string }>(ran.io).threadId;
    const rows = await rt.sessions.list();
    expect(rows.find(r => r.threadId === child)).toMatchObject({ parentThreadId: threadId, rootThreadId: threadId });
    // The child runs at the access every thread on this computer runs at when nobody names one.
    expect(held.starts[2]!.permissionMode).toBe("bypassPermissions");

    // The child's own listing is its tree: the lead and itself, never the person's thread beside them.
    const childPair = { [HOST_URL_ENV]: held.envs[2]![HOST_URL_ENV]!, [HOST_TOKEN_ENV]: held.envs[2]![HOST_TOKEN_ENV]! };
    const seen = json<{ threads: ThreadView[] }>((await thread(childPair, "threads", "--json")).io);
    expect(seen.threads.map(t => t.threadId).sort()).toEqual([threadId, child].sort());
    expect(seen.threads.map(t => t.threadId)).not.toContain(theirs.view().threadId);

    held.release(2, "looked");
    held.release(1, "done");
    held.release(0, "mine");
    await lead.finished;
    await theirs.finished;
  });
});
