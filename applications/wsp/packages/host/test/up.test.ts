// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRuntime, jsonFileStore, STATE_SHAPE_KEY, stateShapeUnreadableLine, stateWrittenByNewerLine, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_VERSION, DEFAULT_PORT, EXIT_CODES, PERSON_HOME_ENV, STATE_SHAPE, type ExecStream, type StateShape } from "@wsp/protocol";
import { BOX_API_URL } from "@wsp/engine";
import { BOX_KEY_ENV, PROVIDER_ENV } from "../src/providers.js";
import { NO_PROJECT_YET } from "../src/verbs.js";
import { stateWriterHere } from "../src/version.js";
import { cli, localWiring, localWorkFolder, noClaudeKeyNote, optsFor, statesHere, up, type CliIO } from "../src/cli.js";
import { noProviderStorageLine } from "../src/storage.js";
import { hostPlaceKeyPath } from "../src/places.js";
import { serviceAddressHere, serviceManagerFor } from "../src/service.js";
import { STARTED_BY_ENV } from "../src/host-lock.js";
import { skillsRefreshedLine } from "../src/mcp-install.js";
import { WSP_SKILL } from "../src/skill.js";
import type { HostLock } from "../src/host-lock.js";
import type { HostHandle } from "../src/server.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

const PAGE = `<!doctype html>
<html><head><script type="module" crossorigin src="/assets/app.js"></script></head>
<body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>
</body></html>
`;

/** What a command printed and how it ended, read the way a client reads it: over execStream, the road serve.ts
 * answers the exec verb with, which wraps the argv in a cd of its own where the in-process exec method never sees
 * that wrapper. */
async function printed(stream: ExecStream): Promise<{ out: string; exitCode: number | null }> {
  let out = "";
  for await (const line of stream.lines) out += line;
  return { out, exitCode: await stream.exited };
}

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
function quietIO(lines: string[] = [], errors: string[] = []): CliIO {
  return { log: l => lines.push(l), error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt };
}

describe("wsp up", () => {
  let dir: string;
  let home: string;
  let webDir: string;
  let statePath: string;
  const handles: HostHandle[] = [];
  /** Runtimes a case built by hand, closed after it whether it got that far or not. */
  const runtimes: Runtime[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-up-home-"));
    home = join(dir, "custom");
    webDir = join(home, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(home, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_up_key");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", home);
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.close();
    for (const rt of runtimes.splice(0)) await rt.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The runtime reads the state file on disk, so what the file holds decides. */
  function fileRuntime(): Runtime {
    return createRuntime({ backend: stubBackend(), store: jsonFileStore(statePath, stateWriterHere()), adapters: {} });
  }

  function stateFile(data: object): void {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(statePath, JSON.stringify(data));
  }

  /** A state holding this computer's own workspace, running on a project folder: listing the workspaces writes this
   * host's roots file and dials the daemon here, which is what a start must not reach before it is refused. */
  function localWorkspaceState(folder: string): void {
    stateFile({
      projects: { pr_l: { id: "pr_l", name: "mac", computer: "here", source: { kind: "folder", path: folder }, path: folder, remote: "https://github.com/dev/mac.git", defaultBranch: "main", memoryKey: "-Users-dev-mac", memoryDir: "/Users/dev/.claude/projects/-Users-dev-mac/memory", createdAt: new Date().toISOString() } },
      workspaces: {
        ws_l: { id: "ws_l", name: "mac", kind: "local", machineId: "local", phase: "running", golden: "", createdAt: new Date().toISOString(), project: "pr_l", spec: {}, firstLife: false, idleWindowMs: null },
      },
    });
  }

  /** The lock of a host that is alive, this process standing in for it, since the pid is what a second start reads. */
  function lockHeldHere(): HostLock {
    const lock: HostLock = { pid: process.pid, port: 4400, wsPort: 4410, address: "127.0.0.1", startedBy: "up", startedAt: new Date().toISOString() };
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "host.lock"), JSON.stringify(lock));
    return lock;
  }

  /** Where this case's own temp folders go, so the daemon folders it counts are its own and not another run's on
   * the same computer. */
  function ownTmp(): string {
    const at = join(dir, "tmp");
    mkdirSync(at, { recursive: true });
    vi.stubEnv("TMPDIR", at);
    return at;
  }

  /** The folder a local daemon makes for its token and its manifest, which it removes when it closes. */
  const daemonFolders = (at: string): string[] => readdirSync(at).filter(name => name.startsWith("wsp-local-daemon-"));

  /** The default app port held, so a start with no flags steps to the next pair and has a step to say. A Mac
   * already serving a host of its own holds it, and a case that cannot bind it reads that as the same held port:
   * what the case needs is the port taken, not this listener in particular. */
  async function heldDefaultPort(): Promise<() => Promise<void>> {
    const server = createServer();
    const bound = await new Promise<boolean>(resolve => {
      server.once("error", () => resolve(false));
      server.listen(DEFAULT_PORT, "127.0.0.1", () => resolve(true));
    });
    return bound ? () => new Promise<void>(resolve => server.close(() => resolve())) : (): Promise<void> => Promise.resolve();
  }

  /** A host that has answered once, which is how every case here settles one before its teardown closes it: a
   * close that lands inside the first milliseconds of a start races the runtime's own listener. */
  async function answered(handle: HostHandle): Promise<HostHandle> {
    expect((await fetch(`http://127.0.0.1:${handle.port}/`)).status).toBe(200);
    return handle;
  }

  async function started(lines: string[]): Promise<HostHandle> {
    const handle = await up(quietIO(lines), { port: 0, wsPort: 0, statePath, webDir, runtime: fileRuntime() });
    if (handle === undefined) throw new Error("up refused");
    handles.push(handle);
    return handle;
  }

  it("serves the app over a state file with a sealed golden and prints the app, runtime and state lines", async () => {
    stateFile({ goldens: { default: SEALED_GOLDEN } });
    const lines: string[] = [];
    const handle = await started(lines);

    expect((await fetch(`http://127.0.0.1:${handle.port}/`)).status).toBe(200);
    const tokenPath = join(home, "state", "host-token");
    expect(lines).toEqual([
      `app         http://127.0.0.1:${handle.port}`,
      `runtime ws  ws://127.0.0.1:${handle.wsPort} (token: ${tokenPath})`,
      `state       ${statePath}`,
      noClaudeKeyNote(false),
    ]);
    expect(readFileSync(tokenPath, "utf8")).toBe(handle.authToken);
  });

  it("the token file is this user's alone, and one an older build left at 0644 is replaced rather than rewritten", async () => {
    stateFile({ goldens: { default: SEALED_GOLDEN } });
    const tokenPath = join(home, "state", "host-token");
    writeFileSync(tokenPath, "an older build's token\n");
    chmodSync(tokenPath, 0o644);
    const handle = await started([]);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenPath, "utf8")).toBe(handle.authToken);
  });

  it("serves a state that holds nothing and says the road, rather than recording a workspace nobody named a project for", async () => {
    // A manifest whose head names no version is a state with nothing to show, the same as an empty one: this is the
    // box story's first line, where the host is installed before anyone has forked or sealed anything. A workspace
    // is one project's copy, so this start records none and the line says what records one.
    stateFile({ goldens: { default: { ...SEALED_GOLDEN, head: 2 } } });
    const lines: string[] = [];
    const errors: string[] = [];
    const rt = createRuntime({ backend: stubBackend(), store: jsonFileStore(statePath, stateWriterHere()), adapters: {}, local: localWiring(home) });
    const handle = await up(quietIO(lines, errors), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    handles.push(handle);
    expect(errors).toEqual([]);
    expect(await rt.workspaces.list()).toEqual([]);
    expect(lines[0]).toBe(NO_PROJECT_YET);
    expect((await fetch(`http://127.0.0.1:${handle.port}/`)).status).toBe(200);
  });

  it("serves a state that holds only a local workspace and no golden: this computer is something to show", async () => {
    stateFile({
      projects: { pr_l: { id: "pr_l", name: "mac", computer: "here", source: { kind: "folder", path: localWorkFolder(home) }, path: localWorkFolder(home), remote: "https://github.com/dev/mac.git", defaultBranch: "main", memoryKey: "-Users-dev-mac", memoryDir: "/Users/dev/.claude/projects/-Users-dev-mac/memory", createdAt: new Date().toISOString() } },
      workspaces: {
        ws_l: { id: "ws_l", name: "mac", kind: "local", machineId: "local", phase: "running", golden: "", createdAt: new Date().toISOString(), project: "pr_l", spec: {}, firstLife: false, idleWindowMs: null },
      },
    });
    const lines: string[] = [];
    const rt = createRuntime({ backend: stubBackend(), store: jsonFileStore(statePath, stateWriterHere()), adapters: {}, local: localWiring(home) });
    const handle = await up(quietIO(lines), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    if (handle === undefined) throw new Error("up refused a state with a local workspace");
    handles.push(handle);
    expect((await fetch(`http://127.0.0.1:${handle.port}/`)).status).toBe(200);
    expect((await rt.workspaces.list()).map(w => [w.name, w.kind])).toEqual([["mac", "local"]]);
  });

  it("a turn on this computer starts in the workspace's own project folder, never in the person's home", async () => {
    const work = localWorkFolder(home);
    stateFile({
      projects: { pr_l: { id: "pr_l", name: "mac", computer: "here", source: { kind: "folder", path: work }, path: work, remote: "https://github.com/dev/mac.git", defaultBranch: "main", memoryKey: "-Users-dev-mac", memoryDir: "/Users/dev/.claude/projects/-Users-dev-mac/memory", createdAt: new Date().toISOString() } },
      workspaces: {
        ws_l: { id: "ws_l", name: "mac", kind: "local", machineId: "local", phase: "running", golden: "", createdAt: new Date().toISOString(), project: "pr_l", spec: {}, firstLife: false, idleWindowMs: null },
      },
    });
    // Not made by building the wiring: a host that only asks whether it has anything to serve builds one too, and a
    // computer that was never set up is left as it was.
    const wiring = localWiring(home);
    expect(existsSync(work)).toBe(false);
    // The exec road asks for the default agent's adapter, for the environment a command runs under; nothing here
    // starts a turn through it.
    const rt = createRuntime({ backend: stubBackend(), store: jsonFileStore(statePath, stateWriterHere()), adapters: { claude: () => ({ steers: false, start: () => { throw new Error("no turn in this case"); } }) }, local: wiring });
    runtimes.push(rt);
    // Made by taking this computer as a machine, which loading the record above does, so the first turn has
    // somewhere to be rather than failing on a missing folder.
    await rt.workspaces.get("ws_l");
    expect(existsSync(work)).toBe(true);
    // The one thing that decides where an agent's shell begins: a turn that started in the home folder is one cd
    // from the checkouts the person works in themselves. The road a client takes is execStream, which wraps the argv
    // in a cd of its own, so it is the road asked here; the in-process method never sees that wrapper. Both sides
    // read through realpath: macOS reaches its temp dir through a symlink, so a shell's pwd and the path built here
    // are two spellings of one folder.
    const where = await printed(await rt.workspaces.execStream("ws_l", ["pwd"]));
    expect(where.exitCode).toBe(0);
    expect(realpathSync(where.out.trim())).toBe(realpathSync(work));
    expect((await printed(await rt.workspaces.execStream("ws_l", ["sh", "-c", "printf mine > seen.txt"]))).exitCode).toBe(0);
    expect(existsSync(join(work, "seen.txt"))).toBe(true);
    expect(existsSync(join(home, "seen.txt"))).toBe(false);
    // And the folder the turn road resolves is that same one, read off the backend the wiring published it on, which
    // is also the folder that backend's own machine runs in: one fact, so the two roads cannot split.
    expect(wiring.backend.folder).toBe(work);
    // Read off the stream and then waited on: a child still writing its run files under the wsp home while this
    // test's folder is swept is a teardown that fails on the files it is racing.
    const ran = await rt.workspaces.execStream("ws_l", ["pwd"]);
    expect(ran.ranIn).toBe(work);
    await printed(ran);
    // The harness's own store stays the person's, wherever their store variable puts it: a sign-in they made is the
    // one a turn uses, so nothing of it moved under the work folder.
    expect(wiring.home("claude").startsWith(work)).toBe(false);
    expect(localWiring(home, { HOME: home }).home("claude")).toBe(join(home, ".claude"));
    await rt.close();
  });

  it("runs a turn under the person's own home when the host serves a home that is not theirs", () => {
    const lab = join(dir, "lab");
    const person = join(dir, "person");
    const wiring = localWiring(lab, { HOME: lab, [PERSON_HOME_ENV]: person });
    // The stores a turn reads are the person's, so the sign-in they made is the one the agent finds, and so is the
    // home the turn runs under: a sign-in on this kind of computer is keyed to the home a person logs in to.
    expect(wiring.home("claude")).toBe(join(person, ".claude"));
    expect(wiring.env()["HOME"]).toBe(person);
    // What is the host's own stays in the home it serves: the folder turns run in and the folder its panes browse.
    expect(wiring.homeDir).toBe(lab);
    expect(wiring.backend.folder.startsWith(lab)).toBe(true);
    // Unnamed, the process's home is the person's, which is every host but a harness's.
    const plain = localWiring(lab, { HOME: lab });
    expect([plain.home("claude"), plain.env()["HOME"]]).toEqual([join(lab, ".claude"), lab]);
  });

  it("the wiring answers this computer's environment as it is when it is asked, not as it was when the wiring was made", async () => {
    vi.stubEnv("WSP_LOGIN_PROBE", "before");
    const wiring = localWiring(home);
    expect(wiring.env()["WSP_LOGIN_PROBE"]).toBe("before");
    vi.stubEnv("WSP_LOGIN_PROBE", "after");
    expect(wiring.env()["WSP_LOGIN_PROBE"]).toBe("after");
    // A variable the process no longer holds leaves nothing behind for a turn to read.
    vi.stubEnv("WSP_LOGIN_PROBE", undefined);
    expect("WSP_LOGIN_PROBE" in wiring.env()).toBe(false);
  });

  it("closing the wiring leaves the turns running on this computer, with the run the next host re-opens them by", async () => {
    const wiring = localWiring(home);
    // Launched off the wiring alone, with no workspace record loaded: the road makes the folder the turn starts in.
    const pidFile = join(home, "child.pid");
    const stream = wiring.execStream()(`sleep 300 & echo $! > ${pidFile}; sleep 300`, { env: {} });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5_000 });
    const child = Number(readFileSync(pidFile, "utf8").trim());
    expect(child).toBeGreaterThan(0);

    await wiring.close!();

    // The turn and its whole tree outlive the host: what the close frees is what this host was holding open.
    expect(() => process.kill(child, 0)).not.toThrow();
    expect(stream.run).toBeDefined();
    expect(await localWiring(home).execStream().attach!(stream.run!, { input: false })).not.toBe("gone");
    // What the close freed is the reading: this process stopped polling that run, so the stream it handed out
    // settles no more and the timer that read it is no longer holding this process open.
    const quiet = await Promise.race([stream.exited.then(() => "settled"), new Promise(resolve => setTimeout(() => resolve("still running"), 500))]);
    expect(quiet).toBe("still running");
    // The turn is ended here by the signal, which reaches the group whether or not anybody is reading it.
    stream.kill();
    await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow(), { timeout: 5_000 });
  }, 15_000);

  it("the panes of a local workspace dial a daemon this host starts on the first ask and closes with the runtime", async () => {
    stateFile({
      projects: { pr_l: { id: "pr_l", name: "mac", computer: "here", source: { kind: "folder", path: localWorkFolder(home) }, path: localWorkFolder(home), remote: "https://github.com/dev/mac.git", defaultBranch: "main", memoryKey: "-Users-dev-mac", memoryDir: "/Users/dev/.claude/projects/-Users-dev-mac/memory", createdAt: new Date().toISOString() } },
      workspaces: {
        ws_l: { id: "ws_l", name: "mac", kind: "local", machineId: "local", phase: "running", golden: "", createdAt: new Date().toISOString(), project: "pr_l", spec: {}, firstLife: false, idleWindowMs: null },
      },
    });
    const wiring = localWiring(home);
    const rt = createRuntime({ backend: stubBackend(), store: jsonFileStore(statePath, stateWriterHere()), adapters: {}, local: wiring });
    runtimes.push(rt);
    // Nothing is bound before a pane asks: the road is what starts the daemon.
    expect(existsSync(join(home, "state", "inbox"))).toBe(false);
    const road = await rt.workspaces.daemonReach("ws_l");
    expect(road.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(road.daemonToken).toMatch(/^[0-9a-f]{48}$/);
    expect((await fetch(road.url)).status).toBe(426);
    // The same daemon answers the next ask; the host binds one port for this computer, not one per pane.
    expect((await rt.workspaces.daemonReach("ws_l")).url).toBe(road.url);
    await rt.close();
    await expect(fetch(road.url)).rejects.toThrow();
    // The teardown closes every runtime a case built, so a second close must be quiet rather than a second wss.close.
    await expect(rt.close()).resolves.toBeUndefined();
  });

  it("wsp up on a port another program holds says who holds it and the line to type, and binds nothing", async () => {
    // Marco's first minute: three guesses at a port, every one answered with the bind's own EADDRINUSE. The port
    // here is one this case holds itself, so nothing another process on this computer does decides the answer.
    stateFile({ goldens: { default: SEALED_GOLDEN } });
    const holder = createServer();
    await new Promise<void>(resolve => holder.listen(0, "127.0.0.1", resolve));
    const at = holder.address();
    if (typeof at !== "object" || at === null) throw new Error("no address");
    const errors: string[] = [];
    try {
      expect(await cli(["up", "--port", String(at.port), "--state", statePath], quietIO([], errors))).toBe(EXIT_CODES.provider);
    } finally {
      await new Promise<void>(resolve => holder.close(() => resolve()));
    }
    expect(errors[0]).toContain(`Port ${at.port} is in use on this computer by `);
    expect(errors[1]).toMatch(/^Nothing was booted\./);
    // Nothing bound, so nothing to stop: the lock is the proof the host never started.
    expect(existsSync(join(home, "state", "host.lock"))).toBe(false);
  });

  it("a host serving a state file somewhere else writes nothing under the person's home, and one on their own wsp says in one line what it brought up to date", async () => {
    // Priya kept her whole session inside /tmp and read six lines about files rewritten under her home folder.
    stateFile({ goldens: { default: SEALED_GOLDEN } });
    const user = join(dir, "user");
    const stale = join(user, ".claude", "skills", "wsp", "SKILL.md");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "an older wsp's skill\n");
    const lines: string[] = [];
    await answered(await started(lines));
    // The state file here is not this wsp home's own, so nothing of the person's is touched: not the skill copy
    // their agent holds, and not a line about it.
    expect(readFileSync(stale, "utf8")).toBe("an older wsp's skill\n");
    expect(lines.filter(l => l.includes("skill"))).toEqual([]);

    // The same start on this home's own state file: the copy is brought up to date, in one line naming it.
    for (const h of handles.splice(0)) await h.close();
    const own = join(home, "state.json");
    writeFileSync(own, JSON.stringify({ goldens: { default: SEALED_GOLDEN } }));
    const mine: string[] = [];
    handles.push(await answered(await up(quietIO(mine), { port: 0, wsPort: 0, statePath: own, webDir, runtime: createRuntime({ backend: stubBackend(), store: jsonFileStore(own, stateWriterHere()), adapters: {} }) })));
    expect(readFileSync(stale, "utf8")).toBe(WSP_SKILL);
    expect(mine).toContain(skillsRefreshedLine(["~/.claude/skills/wsp/SKILL.md"]));
    expect(mine.filter(l => l.includes("skill"))).toHaveLength(1);
  });

  it("a host on another home writes every file of its own there and nothing under the home a bare line picks", async () => {
    // The reading this rule is from: a host on a throwaway home still rewrote the roots file under the person's
    // own wsp home and pointed a file there at itself, so for that minute a bare wsp line dialled the other host.
    const user = join(dir, "user");
    const folder = localWorkFolder(home);
    localWorkspaceState(folder);
    const rt = createRuntime({ backend: stubBackend(), store: jsonFileStore(statePath, stateWriterHere()), adapters: {}, local: localWiring(home, process.env, undefined, statePath) });
    runtimes.push(rt);
    handles.push(await answered(await up(quietIO(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt })));

    // The state file's own folder holds this host's roots file, naming the project its workspace stands on.
    await vi.waitFor(() => expect(existsSync(join(home, "state", "roots"))).toBe(true), { timeout: 5_000 });
    expect(readFileSync(join(home, "state", "roots"), "utf8")).toContain(folder);
    // Nothing under the home its daemon browses from, which is one folder however many hosts run here.
    expect(existsSync(join(home, ".wsp"))).toBe(false);
    // And nothing under the home a line with no --state and no WSP_HOME picks: no pointer, no roots, no inbox.
    expect(existsSync(join(user, ".wsp"))).toBe(false);
  });

  it("a state file a newer wsp wrote is refused once, before the runtime whose own readers would meet it again", async () => {
    // A host on a state file it could not read wrote that refusal into its log twice, once bare and once behind
    // the cost tracker's line with the whole error and its stack under it. One reader meets it now.
    const wrote: StateShape = { shape: STATE_SHAPE + 1, wsp: "9.9.9", daemon: DAEMON_VERSION + 1, bin: "/Applications/wsp.app/Contents/Resources/bin.js", at: "2026-09-19T05:00:00.000Z" };
    stateFile({ workspaces: {}, [STATE_SHAPE_KEY]: wrote });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const lines: string[] = [];
      await expect(up(quietIO(lines), { port: 0, wsPort: 0, statePath, webDir })).rejects.toThrow(stateWrittenByNewerLine(statePath, wrote));
      // Whatever a reader built behind this start would have said lands on the log a moment after the throw.
      await new Promise(done => setTimeout(done, 50));
      expect(warned.mock.calls.flat().map(a => String(a)).join("\n")).not.toContain("was written by a newer wsp");
      expect(lines.join("\n")).not.toContain("was written by a newer wsp");
      // Nothing bound and nothing took the lock, so there is nothing for wsp down to stop.
      expect(existsSync(join(home, "state", "host.lock"))).toBe(false);
    } finally {
      warned.mockRestore();
    }
  });

  it("a start that refuses its state mints no key, so the home is as the refusal found it", async () => {
    // The key is the place wiring's, minted beside the state at its first read, so a start that refuses before it wires places leaves none.
    const wrote: StateShape = { shape: STATE_SHAPE + 1, wsp: "9.9.9", daemon: DAEMON_VERSION + 1, bin: "/Applications/wsp.app/Contents/Resources/bin.js", at: "2026-09-19T05:00:00.000Z" };
    stateFile({ workspaces: {}, [STATE_SHAPE_KEY]: wrote });
    await expect(up(quietIO(), { port: 0, wsPort: 0, statePath, webDir })).rejects.toThrow(stateWrittenByNewerLine(statePath, wrote));
    expect(existsSync(hostPlaceKeyPath(statePath))).toBe(false);
    expect(readdirSync(join(home, "state"))).toEqual(["state.json"]);
  });

  it("a state whose shape document does not parse is refused before anything is minted", async () => {
    // The reading this is from: a copy of the live state had its $shape set to the bare number by hand, and the
    // host served it, minted its key and dialled the provider off a file it could not say the shape of.
    stateFile({ workspaces: {}, [STATE_SHAPE_KEY]: 3 });
    // A reading that serves the copy hands back a host, which goes into the teardown rather than staying up.
    const start = up(quietIO(), { port: 0, wsPort: 0, statePath, webDir }).then(handle => {
      handles.push(handle);
      return handle;
    });
    await expect(start).rejects.toThrow(stateShapeUnreadableLine(statePath, 3));
    expect(existsSync(hostPlaceKeyPath(statePath))).toBe(false);
    expect(readdirSync(join(home, "state"))).toEqual(["state.json"]);
  });

  it("a refused start prints the refusal and nothing before it, whichever refusal it is", async () => {
    // The reading this rule is from: a start refused on the shape of its state file printed "Serving on 4401 and
    // 4411" first, and nothing had bound a port. Every refusal a start throws comes after the ports are picked.
    stateFile({ workspaces: {}, [STATE_SHAPE_KEY]: 3 });
    const release = await heldDefaultPort();
    const lines: string[] = [];
    const errors: string[] = [];
    try {
      // No --port, so the default pair is the one asked for and the held one is stepped over: this is the line a
      // person types beside a host that is already serving.
      expect(await cli(["up", "--state", statePath], quietIO(lines, errors))).not.toBe(0);
      expect(errors).toEqual([stateShapeUnreadableLine(statePath, 3)]);
      expect(lines).toEqual([]);
      expect(readdirSync(join(home, "state"))).toEqual(["state.json"]);
    } finally {
      await release();
    }
  });

  it("wsp up records that it brought the host up, so wsp down has a road to stop it", async () => {
    stateFile({ goldens: { default: SEALED_GOLDEN } });
    await answered(await started([]));
    expect((JSON.parse(readFileSync(join(home, "state", "host.lock"), "utf8")) as HostLock).startedBy).toBe("up");
  });

  it("a second wsp up beside a serving host is refused before it picks ports, reads keys or builds anything", async () => {
    // The reading this rule is from: the second start printed the lock's sentence and had by then stepped to the
    // next pair of ports, rewritten the roots file under the live home and started a daemon of its own against it.
    const folder = localWorkFolder(home);
    localWorkspaceState(folder);
    const lock = lockHeldHere();
    const tmp = ownTmp();
    const lines: string[] = [];
    const errors: string[] = [];

    expect(await cli(["up", "--port", "0", "--ws-port", "0", "--state", statePath], quietIO(lines, errors))).not.toBe(0);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`(pid ${lock.pid}) is already serving ${statePath} on port ${lock.port} (ws ${lock.wsPort})`);
    expect(lines.join("\n")).not.toContain("Serving on");
    // The home is as the refusal found it: no roots file this start wrote, no pairing key it minted.
    expect(readdirSync(join(home, "state")).sort()).toEqual(["host.lock", "state.json"]);
    expect(daemonFolders(tmp)).toEqual([]);
  });

  it("a start refused after it built its runtime closes what it built, so nothing is left running", async () => {
    const folder = localWorkFolder(home);
    localWorkspaceState(folder);
    const lock = lockHeldHere();
    const tmp = ownTmp();
    const children = (): number => process.getActiveResourcesInfo().filter(r => r === "ChildProcess").length;
    const before = children();

    await expect(up(quietIO(), { port: 0, wsPort: 0, statePath, webDir })).rejects.toThrow(`(pid ${lock.pid}) is already serving ${statePath}`);

    // The refusal reaches the caller only once the runtime it was thrown past has been closed: the daemon sync this
    // start fired as it listed the workspaces has run to its end, which its roots file is the trace of, and the
    // daemon it dialled is closed with its folder. A start that leaves one leaves the shell waiting on it.
    expect(existsSync(join(home, "state", "roots"))).toBe(true);
    expect(daemonFolders(tmp)).toEqual([]);
    expect(children()).toBeLessThanOrEqual(before);
  });

  it("wsp up on a state file this computer's manager is registered to serve starts nothing and names the line that starts the service", async () => {
    // The incident this rule is from: the service's host was down for a moment and the next line to need a host
    // started one from whatever build it came from, on the state file the service owns.
    stateFile({ goldens: { default: SEALED_GOLDEN } });
    // The unit this computer's own manager would hold, read off that manager rather than named here: the gate runs
    // on a Mac and ci on Linux, and the two write their units in different places under different words.
    const at = serviceAddressHere(statePath);
    const manager = serviceManagerFor(platform());
    if (manager === undefined) return;
    const held = manager.held(at)[0]!;
    mkdirSync(dirname(held.unit.path), { recursive: true });
    writeFileSync(held.unit.path, "a unit this computer's manager holds\n");
    const errors: string[] = [];
    try {
      expect(await cli(["up", "--port", "0", "--ws-port", "0", "--state", statePath], quietIO([], errors))).toBe(EXIT_CODES.provider);
      expect(errors).toEqual([`${statePath} is served by the ${held.words} ${held.unit.name}, which is not running; wsp up --service --state ${statePath} starts it again`]);
      // Nothing bound and nothing took the lock, which is the whole point: the records stay as the service left them.
      expect(existsSync(join(home, "state", "host.lock"))).toBe(false);

      // The service's own host is that same line with the word its unit carries, and it serves and says so in its lock.
      vi.stubEnv(STARTED_BY_ENV, "service");
      await answered(await started([]));
      expect((JSON.parse(readFileSync(join(home, "state", "host.lock"), "utf8")) as HostLock).startedBy).toBe("service");

      // And with that host serving, the sentence about a service that is not running would be false: the line a
      // person types reads the lock's own refusal instead, naming the pid and how to stop it.
      vi.stubEnv(STARTED_BY_ENV, "");
      const second: string[] = [];
      expect(await cli(["up", "--port", "0", "--ws-port", "0", "--state", statePath], quietIO([], second))).not.toBe(0);
      expect(second.join("\n")).toContain(`is already serving ${statePath}`);
      expect(second.join("\n")).not.toContain("which is not running");
    } finally {
      rmSync(held.unit.path, { force: true });
    }
  });

  it("a host the service started records the mark in its lock and carries it into nothing it starts", async () => {
    // Everything this host starts inherits the environment of its own process, the threads it runs and the daemon its panes dial alike.
    stateFile({ goldens: { default: SEALED_GOLDEN } });
    vi.stubEnv(STARTED_BY_ENV, "service");
    // The wiring a turn on this computer runs under, made while the mark stands: it answers the environment as it is when it is asked.
    const wiring = localWiring(home, process.env, undefined, statePath);
    expect(wiring.env()[STARTED_BY_ENV]).toBe("service");
    const rt = createRuntime({ backend: stubBackend(), store: jsonFileStore(statePath, stateWriterHere()), adapters: {}, local: wiring });
    runtimes.push(rt);

    handles.push(await answered(await up(quietIO(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt })));

    expect((JSON.parse(readFileSync(join(home, "state", "host.lock"), "utf8")) as HostLock).startedBy).toBe("service");
    expect(STARTED_BY_ENV in process.env).toBe(false);
    expect(STARTED_BY_ENV in wiring.env()).toBe(false);
  });

  describe("a host on a state file in another folder", () => {
    /** A state file away from the wsp home, with the home's own .env holding a key and a pick, as a person's live
     * home does. Every dial this start could make is recorded rather than made. */
    function elsewhere(beside?: string): { state: string; folder: string; dialled: string[] } {
      writeFileSync(join(home, ".env"), `SOLARI_API_KEY=slr_live_fake_home_key\nWSP_PROVIDER=box\n`);
      const folder = join(dir, "elsewhere");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "state.json"), JSON.stringify({ workspaces: {} }));
      if (beside !== undefined) writeFileSync(join(folder, ".env"), beside);
      // Nothing of a provider in this shell either: the files are the only places a key or a pick is, so a shell
      // that exported one cannot decide a case here.
      vi.stubEnv("SOLARI_API_KEY", undefined);
      vi.stubEnv(BOX_KEY_ENV, undefined);
      vi.stubEnv(PROVIDER_ENV, undefined);
      const dialled: string[] = [];
      vi.stubGlobal("fetch", (input: unknown) => {
        dialled.push(String(input));
        return Promise.reject(new Error("no request leaves this test"));
      });
      return { state: join(folder, "state.json"), folder, dialled };
    }

    /** The start every case here takes: the flags a person types, read into the environment every verb is handed. */
    async function serving(state: string, lines: string[]): Promise<HostHandle> {
      const handle = await up(quietIO(lines), { ...optsFor({ state, port: "0", "ws-port": "0" }, process.env), webDir });
      handles.push(handle);
      return handle;
    }

    it("reads no key of the wsp home's, so it is wired to no provider, asks no account anything and says so", async () => {
      const { state, folder, dialled } = elsewhere();
      const lines: string[] = [];
      await serving(state, lines);
      expect(dialled).toEqual([]);
      expect(lines).toContain(noProviderStorageLine(state));
      // Nothing of this host's keys was written beside its state either: the file is the person's to write.
      expect(readdirSync(folder)).not.toContain(".env");
    });

    it("takes the pick out of the .env beside that state, and a wired provider gets no such line", async () => {
      const { state, dialled } = elsewhere("WSP_PROVIDER=box\n");
      const lines: string[] = [];
      await serving(state, lines);
      // Wired to a provider that forks machines, which is the note a person reads about their claude key.
      expect(lines).toContain(noClaudeKeyNote(false));
      expect(lines.join("\n")).not.toContain("wired to no provider");
      // A pick with no key beside it still has an account to ask, and the one asked is the row the file named.
      expect(dialled.length).toBeGreaterThan(0);
      for (const at of dialled) expect(at.startsWith(BOX_API_URL)).toBe(true);
    });
  });

  it("wsp up refuses a flag it does not answer in and starts nothing", async () => {
    const errors: string[] = [];
    const code = await cli(["up", "--json", "--port", "0", "--ws-port", "0", "--state", statePath], quietIO([], errors));
    expect(code).toBe(3);
    expect(errors[0]).toContain("Unknown option '--json' for wsp up");
    expect(existsSync(join(home, "state", "host.lock"))).toBe(false);
  });

  it("plain wsp prints the help and serves nothing, since typing the program's name asks what it is", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    expect(await cli(["--state", statePath], quietIO(lines, errors))).toBe(0);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("usage:");
    expect(existsSync(join(home, "state", "host.lock"))).toBe(false);
  });

  it("starts the server in one place that init's tail and up both call", () => {
    const cliSource = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const initSource = readFileSync(new URL("../src/init.ts", import.meta.url), "utf8");
    expect(cliSource.match(/startHost\(/g)).toHaveLength(1);
    expect(initSource).not.toMatch(/startHost\(/);
  });

  it("--port alone derives the websocket port, and every command of the shared parse works on that one pair", () => {
    expect(optsFor({ port: "4401", state: statePath })).toMatchObject({ port: 4401, wsPort: 4411, named: true });
    expect(optsFor({ state: statePath })).toMatchObject({ port: 4400, wsPort: 4410, named: false });
    expect(optsFor({ port: "4401", "ws-port": "9000", state: statePath })).toMatchObject({ port: 4401, wsPort: 9000, named: true });
    // wsp up, wsp init and the rest read their pair from this one call, so neither can derive it its own way: the
    // parse calls optsFor once (the second hit is its own declaration) and optsFor is the only reader of the rule.
    const cliSource = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(cliSource.match(/optsFor\(/g)).toHaveLength(2);
    expect(cliSource.match(/portsAsked\(/g)).toHaveLength(1);
    expect(cliSource).not.toMatch(/\b(4400|4410)\b/);
  });

  it("the state files a taken port is asked about are this run's and this computer's default, each once", () => {
    expect(statesHere(statePath)).toEqual([statePath, join(home, "state.json")]);
    expect(statesHere(join(home, "state.json"))).toEqual([join(home, "state.json")]);
  });
});
