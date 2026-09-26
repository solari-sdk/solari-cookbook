// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { HERE_PLACE_ID, alreadyRecorded, copyPathFor, inFolder, machineWord, undrivenRefusal, NO_SUCH_TURN, NOTIFY_ME, noWorkspaceRefusal, deviceHeldRefusal, registeredLine, REGISTERING_LINE, RELAY_TICKET_REFUSAL, relayedRecordRefusal, relayedRefusal, RUN_GONE_LINE, THIS_COMPUTER, TICKET_ORIGIN, TURN_TOKEN_ENV, type AdapterAttachOptions, type AdapterEvent, type EventUnion, type ExecStream, type PortForward, type ProjectImportEvent, type TurnResult, type WorkspaceStatus } from "@wsp/protocol";
import type { MachineExecOptions } from "../src/machine-exec.js";
import { createRuntime, NO_COPIER_HERE, type HarnessAdapterContext, type HarnessAdapterFactory, type HarnessSession, type LocalWiring, type ProjectExportOptions, type ProjectImportOptions, type Runtime } from "../src/runtime.js";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { localExecStream } from "../src/local-exec.js";
import { serveRuntime, type ForwardsSource } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, copyingFake, createOn, projectOn, testPlatform } from "./stub-backend.js";
import { grandchild, sweepStrays } from "./strays.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

/** A scripted adapter that runs one real command on the machine it was given through ctx.execStream and answers with
 * its output: on a local workspace ctx.execStream is the local child factory, so a reply landing proves the runtime
 * drove the local backend. */
const echoAdapter: HarnessAdapterFactory = ctx => ({
  steers: false,
  start: ({ onEvent }) => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const finished = (async () => {
      const stream = ctx.execStream("printf pong", { env: { ...ctx.env } });
      let out = "";
      for await (const line of stream.lines) out += line;
      await stream.exited;
      onEvent({ type: "session.start", sessionId });
      onEvent({ type: "turn.delta", sessionId, kind: "text", text: out });
      const result = { status: "completed", text: out } as const;
      onEvent({ type: "turn.done", sessionId, result });
      onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return result;
    })();
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

/** An adapter that builds its command the way the real ones do, `inFolder(cwd, ...)` around the binary, and answers
 * with the folder that command landed in: the reply is the folder the runtime resolved for the turn, read off the
 * machine rather than off the argument. */
const pwdAdapter: HarnessAdapterFactory = ctx => ({
  steers: false,
  start: ({ cwd, onEvent }) => {
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const finished = (async () => {
      const stream = ctx.execStream(inFolder(cwd, "pwd"), { env: { ...ctx.env } });
      let out = "";
      for await (const line of stream.lines) out += line;
      await stream.exited;
      onEvent({ type: "session.start", sessionId });
      const result = { status: "completed", text: out } as const;
      onEvent({ type: "turn.done", sessionId, result });
      onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return result;
    })();
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

/** An adapter that leads a real child on this computer for as long as its turn runs and reports the process it
 * leads, as the shipped ones do off their stream. */
function pidAdapter(): { factory: HarnessAdapterFactory; end: (nth: number) => void } {
  const ends: (() => void)[] = [];
  const factory: HarnessAdapterFactory = ctx => ({
    steers: false,
    start: ({ onEvent }) => {
      const sessionId = randomUUID();
      const stream = ctx.execStream("sleep 30", { env: { ...ctx.env } });
      const result: TurnResult = { status: "completed", text: "done" };
      const finished = new Promise<TurnResult>(resolve => {
        ends.push(() => {
          stream.kill();
          onEvent({ type: "turn.done", sessionId, result });
          onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          resolve(result);
        });
      });
      onEvent({ type: "session.start", sessionId });
      return { localId: sessionId, finished, interrupt: async () => {}, ...(stream.pid !== undefined ? { pid: stream.pid } : {}) };
    },
  });
  return { factory, end: nth => ends[nth]!() };
}

/** An adapter that says what the launch environment named this turn's token, read out of a real child process on
 * this computer, and whose turn runs on until it is ended: the token means something only while the turn does. It
 * steers, so a line sent into one of its running turns lands there rather than opening another. */
function tokenAdapter(): { factory: HarnessAdapterFactory; said: string[]; steered: string[]; end: (nth: number) => void } {
  const ends: (() => void)[] = [];
  const said: string[] = [];
  const steered: string[] = [];
  const factory: HarnessAdapterFactory = ctx => ({
    steers: true,
    start: ({ resume, onEvent }) => {
      const sessionId = resume ?? randomUUID();
      const result: TurnResult = { status: "completed", text: "handed off" };
      const finished = new Promise<TurnResult>(resolve => {
        ends.push(() => {
          onEvent({ type: "turn.done", sessionId, result });
          onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          resolve(result);
        });
      });
      void (async () => {
        const stream = ctx.execStream(`printf %s "$${TURN_TOKEN_ENV}"`, { env: { ...ctx.env } });
        let out = "";
        for await (const line of stream.lines) out += line;
        await stream.exited;
        said.push(out);
        onEvent({ type: "session.start", sessionId });
      })();
      return {
        localId: sessionId,
        finished,
        interrupt: async () => {},
        steer: async (prompt: string) => {
          steered.push(prompt);
          return "accepted" as const;
        },
      };
    },
  });
  return { factory, said, steered, end: (nth: number) => ends[nth]!() };
}

/** An adapter that writes down every launch it was handed and finishes the turn at once, so a case reads which
 * turns ran, on which prompt and on which thread's session. */
function notingAdapter(): { factory: HarnessAdapterFactory; starts: { prompt: string; resume?: string }[] } {
  const starts: { prompt: string; resume?: string }[] = [];
  const factory: HarnessAdapterFactory = () => ({
    steers: false,
    start: ({ prompt, resume, onEvent }) => {
      const sessionId = resume ?? randomUUID();
      starts.push({ prompt, ...(resume !== undefined ? { resume } : {}) });
      const result: TurnResult = { status: "completed", text: "done" };
      onEvent({ type: "session.start", sessionId });
      onEvent({ type: "turn.done", sessionId, result });
      onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
    },
  });
  return { factory, starts };
}

/** A git repo inside the test's own root, so a project here is a real one and the folder a thread opens in is a
 * folder the test can name. */
function repoIn(root: string, name = "work"): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  execFileSync("git", ["init", "-q", folder]);
  return realpathSync(folder);
}

describe("local workspace", () => {
  let root: string;
  let store: Store;
  let localWiring: LocalWiring;
  /** Every options object the registry handed the local factory, in order. */
  let handed: (MachineExecOptions | undefined)[];
  /** Stands in for the loopback daemon the host starts: a plain GET to a WebSocket server is answered 426, which is
   * what the status probe reads as the daemon being up. */
  let probe: { port: number; close: () => Promise<void> };
  const runtime = (): Runtime =>
    createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: localWiring });

  beforeAll(async () => {
    const server = createServer((_req, res) => {
      res.writeHead(426);
      res.end();
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    probe = { port: (server.address() as AddressInfo).port, close: () => new Promise<void>(done => server.close(() => done())) };
  });
  afterAll(() => probe.close());

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localws-"));
    store = memoryStore();
    // Each case's own list, closed over by that case's wiring: a runtime an earlier case left running still asks
    // its own wiring for a factory, and a shared variable would file those asks under the case reading it.
    const mine: (MachineExecOptions | undefined)[] = [];
    handed = mine;
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => {
        mine.push(o);
        return localExecStream({ root, runDir: join(root, "runs"), ...o });
      },
      home: () => join(root, ".claude"),
      homeDir: root,
      // Beside the host's own files rather than under the home the daemon browses: the wiring says where, and
      // this is what the runtime writes the browse roots into.
      rootsPath: join(root, "host", "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("wsp new --local makes the one local workspace, listed with kind local and no image", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "my-mac" });
    expect(ws.kind).toBe("local");
    expect(ws.name).toBe("my-mac");
    expect(ws.golden).toBe("");
    expect(ws.phase).toBe("running");
    // The view carries the person's home, so a client shows a folder under it as their shell would.
    expect(ws.home).toBe(root);
    const listed = await rt.workspaces.list();
    expect(listed.map(w => ({ name: w.name, kind: w.kind }))).toEqual([{ name: "my-mac", kind: "local" }]);
    // This computer is forked by nobody, so no provider rides its view and a row reads the kind's own words for it.
    expect(listed.map(w => w.provider)).toEqual([undefined]);
  });

  it("a listing names the process a turn runs in on this computer while it runs, and never once it is over", async () => {
    const { factory, end } = pidAdapter();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: factory }, local: localWiring });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const handle = await rt.sessions.start(ws.id, { prompt: "work" });
    const running = (await rt.sessions.list(ws.id))[0]!;
    expect(running.status).toBe("running");
    // A process this computer is running right now, which is what the pane heads the thread's tree with.
    expect(() => process.kill(running.pid!, 0)).not.toThrow();
    end(0);
    await handle.finished;
    const over = (await rt.sessions.list(ws.id))[0]!;
    expect(over.status).not.toBe("running");
    expect(over.pid).toBeUndefined();
  });

  it("a host with no copy road refuses the first workspace of a project here, since every workspace here is a copy", async () => {
    const { copier: _none, ...bare } = localWiring;
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: bare });
    const project = await projectOn(rt, HERE_PLACE_ID, repoIn(root));
    // This wiring hands in no copier, so the first piece of work has no road to a copy and the sentence says so.
    // With one wired it is a copy of the folder; that is local-copy.test.ts.
    await expect(rt.workspaces.create({ project: project.id, name: "mac" })).rejects.toThrow(NO_COPIER_HERE);
    expect(await rt.workspaces.list()).toEqual([]);
    // A second project on a host that copies is a second workspace: this computer runs as many as there are
    // folders to copy.
    const copying = runtime();
    const first = await projectOn(copying, HERE_PLACE_ID, repoIn(root, "one"));
    const second = await projectOn(copying, HERE_PLACE_ID, repoIn(root, "other"));
    expect((await copying.workspaces.create({ project: first.id, name: "mac" })).kind).toBe("local");
    expect((await copying.workspaces.create({ project: second.id, name: "mac2" })).kind).toBe("local");
  });

  it("a create on this computer that its own refusal stops asks nothing of the workspace it names as a parent", async () => {
    const rt = runtime();
    const project = await projectOn(rt, HERE_PLACE_ID, repoIn(root));
    const parent = await rt.workspaces.create({ project: project.id, name: "mac" });
    // The folder the parent works in is gone, so a read of the branch it is on answers with git's own failure. A
    // create that reads it before its own refusals would answer about that read instead of about itself.
    rmSync(join(root, "work"), { recursive: true, force: true });
    await expect(rt.workspaces.create({ project: project.id, name: "mac2", parent: parent.id }, "relayed")).rejects.toThrow(relayedRecordRefusal("mac2"));
  });

  it("a turn on this computer runs under the person's own login and no sandbox flag: this computer is not a machine", async () => {
    const seen: HarnessAdapterContext[] = [];
    const seeing: HarnessAdapterFactory = ctx => {
      seen.push(ctx);
      return echoAdapter(ctx);
    };
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: seeing }, local: localWiring });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await (await rt.sessions.start(ws.id, { prompt: "say pong" })).finished;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(c => c.env["IS_SANDBOX"] === undefined && c.env["DISABLE_AUTOUPDATER"] === undefined)).toBe(true);
    expect(seen.every(c => c.env["PATH"] === localWiring.env()["PATH"])).toBe(true);
  });

  it("the local kind asks the wiring for that environment at every turn, so a runtime outlives the environment it was built on", async () => {
    const seen: HarnessAdapterContext[] = [];
    const seeing: HarnessAdapterFactory = ctx => {
      seen.push(ctx);
      return echoAdapter(ctx);
    };
    let bin = "/first/bin";
    localWiring.env = () => ({ PATH: bin });
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: seeing }, local: localWiring });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await (await rt.sessions.start(ws.id, { prompt: "say pong" })).finished;
    bin = "/second/bin";
    await (await rt.sessions.start(ws.id, { prompt: "say pong" })).finished;
    expect(seen.at(-1)!.env["PATH"]).toBe("/second/bin");
  });

  it("a thread starts on the local workspace and its reply lands, run through the local exec stream", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const handle = await rt.sessions.start(ws.id, { prompt: "say pong" });
    const result = await handle.finished;
    expect(result.status).toBe("completed");
    expect(result.text).toBe("pong");
  });

  it("a turn on this computer launches its real child process with its own token, and that token resolves notify me to its thread", async () => {
    const held = tokenAdapter();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: held.factory }, local: localWiring });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const turn = await rt.sessions.start(ws.id, { prompt: "coordinate" });
    const until = async (has: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !has(); i++) await new Promise(r => setTimeout(r, 10));
      if (!has()) throw new Error("the turn never got there");
    };
    // The token the real child process read out of its own environment, not one this test handed the adapter.
    await until(() => held.said.length === 1);
    const token = held.said[0]!;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    // Anything else for a token is refused, so what the host resolves is this launch's own variable and nothing else.
    await expect(rt.sessions.start(ws.id, { prompt: "build it", notify: [NOTIFY_ME], turnToken: "not-a-token" })).rejects.toThrow(NO_SUCH_TURN);
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: [NOTIFY_ME], turnToken: token });
    expect(kid.view().threadId).not.toBe(turn.view().threadId);
    held.end(1);
    await kid.finished;
    // The child's end reached the thread that launched it, which is what me resolved to.
    await until(() => held.steered.length === 1);
    expect(held.steered[0]).toContain(`thread ${kid.view().threadId!.slice(0, 8)} finished (completed)`);
    held.end(0);
    await turn.finished;
    await rt.close();
  });

  it("a turn on this computer runs its real child with the vault's token in its environment, through the agent's own adapter", async () => {
    const said: string[] = [];
    // The shipped Claude adapter, built by the registry off the context this runtime hands it: what a real turn on
    // this computer is launched with, environment and all.
    const throughClaude: HarnessAdapterFactory = ctx => {
      const claude = HARNESS_ADAPTERS.claude(ctx);
      return {
        steers: false,
        start: ({ onEvent }) => {
          const sessionId = randomUUID();
          const result: TurnResult = { status: "completed", text: "read" };
          const finished = (async (): Promise<TurnResult> => {
            const stream = ctx.execStream('printf %s "$CLAUDE_CODE_OAUTH_TOKEN"', { env: { ...claude.env } });
            let out = "";
            for await (const line of stream.lines) out += line;
            await stream.exited;
            said.push(out);
            onEvent({ type: "session.start", sessionId });
            onEvent({ type: "turn.done", sessionId, result });
            onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
            return result;
          })();
          return { localId: sessionId, finished, interrupt: async () => {} };
        },
      };
    };
    const token = "sk-ant-oat01-TESTONLY";
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: throughClaude }, local: localWiring, vault: () => ({ CLAUDE_CODE_OAUTH_TOKEN: token }) });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac", project: (await projectOn(rt, HERE_PLACE_ID, repoIn(root, "vault"))).id });
    await (await rt.sessions.start(ws.id, { prompt: "read your environment" })).finished;
    // What the real child process printed out of its own environment, not what the test handed the adapter.
    expect(said).toEqual([token]);
    await rt.close();
  });

  it("the registry hands the local factory the same limits a cloud turn gets: the turn's own by default, none for the exec verb", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await (await rt.sessions.start(ws.id, { prompt: "say pong" })).finished;
    const stream = await rt.workspaces.execStream(ws.id, ["true"]);
    for await (const _line of stream.lines) void _line;
    await stream.exited;
    // The adapter is built once per road that asks it something (catalog, title, the turn), each with the turn's own limits.
    expect(handed.length).toBeGreaterThan(1);
    expect(handed.slice(0, -1).every(o => o === undefined)).toBe(true);
    expect(handed.at(-1)).toEqual({ idleMs: Number.POSITIVE_INFINITY, deadlineMs: Number.POSITIVE_INFINITY });
  });

  it("the view names the copy beside the project's folder, never the folder itself, so the app's line under the box says what the runtime did", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    // The workspace here is a copy of the folder the project was recorded on, and a thread on it starts there.
    expect(ws.folder).toBe(copyPathFor(ws.project.path, "mac"));
    expect(ws.folder).not.toBe(ws.project.path);
    expect((await rt.workspaces.get(ws.id)).folder).toBe(ws.folder);
    expect((await rt.status.list()).find(s => s.id === ws.id)?.folder).toBe(ws.folder);
    await rt.close();
  });

  it("a turn over the wire starts in the workspace's own folder, never the person's home, and the thread's row names it", async () => {
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: pwdAdapter }, local: localWiring });
    const folder = repoIn(root);
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac", project: (await projectOn(rt, HERE_PLACE_ID, folder)).id });
    const result = await (await rt.sessions.start(ws.id, { prompt: "where are you" })).finished;
    expect(realpathSync(result.text!.trim())).toBe(realpathSync(copyPathFor(folder, "mac")));
    const [session] = await rt.sessions.list(ws.id);
    expect(session!.cwd).toBe(copyPathFor(folder, "mac"));
    await rt.close();
  });

  it("a command over the wire, the road wsp exec takes, starts in that same folder", async () => {
    const rt = runtime();
    const folder = repoIn(root);
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac", project: (await projectOn(rt, HERE_PLACE_ID, folder)).id });
    const stream = await rt.workspaces.execStream(ws.id, ["pwd"]);
    // The stream says which folder it resolved, so the client that prints it never restates the rule.
    expect(stream.ranIn).toBe(copyPathFor(folder, "mac"));
    let out = "";
    for await (const line of stream.lines) out += line;
    expect(await stream.exited).toBe(0);
    expect(realpathSync(out.trim())).toBe(realpathSync(copyPathFor(folder, "mac")));
    await rt.close();
  });

  it("a command over the wire carries none of the values the vault holds for MCP servers, since it starts no agent", async () => {
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: HARNESS_ADAPTERS.claude }, local: localWiring, vault: () => ({ WSP_MCP_LINEAR_AUTHORIZATION: "lin_api_TESTONLY" }) });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const stream = await rt.workspaces.execStream(ws.id, ["env"]);
    let out = "";
    for await (const line of stream.lines) out += line;
    expect(await stream.exited).toBe(0);
    expect(out).toContain("PATH=");
    expect(out).not.toContain("lin_api_TESTONLY");
    await rt.close();
  });

  it("exec runs on this computer and returns the exit code; files read and write under the folder", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    expect((await rt.workspaces.exec(ws.id, "exit 4")).exitCode).toBe(4);
    expect((await rt.workspaces.exec(ws.id, "printf saved > f.txt")).exitCode).toBe(0);
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("saved");
    expect((await rt.workspaces.exec(ws.id, "cat f.txt")).stdout).toBe("saved");
  });

  it("every verb its machine cannot take refuses with the capability's sentence", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const cannot = /is this computer, which wsp does not run; it cannot/;
    await expect(rt.workspaces.nap(ws.id)).rejects.toThrow(cannot);
    // A computer is running while the host is: the wake every thread road sends first is a no-op, not a refusal.
    expect((await rt.workspaces.wake(ws.id)).phase).toBe("running");
    await expect(rt.workspaces.upgrade(ws.id)).rejects.toThrow(cannot);
    await expect(rt.workspaces.rebuild(ws.id)).rejects.toThrow(cannot);
    await expect(rt.workspaces.updateImage(ws.id)).rejects.toThrow(cannot);
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toThrow(undrivenRefusal("mac", machineWord("local"), "be snapshotted"));
  });

  it("every verb refuses a request relayed from a machine with the one sentence", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const thread = await rt.sessions.start(ws.id, { prompt: "hi" });
    await thread.finished;
    const sessionId = thread.view().id;
    const bundler = {} as ProjectImportOptions["bundler"];
    const lander = {} as ProjectExportOptions["lander"];
    const verbs: [string, () => Promise<unknown>][] = [
      ["workspaces.get", () => rt.workspaces.get(ws.id, "relayed")],
      ["workspaces.nap", () => rt.workspaces.nap(ws.id, "relayed")],
      ["workspaces.wake", () => rt.workspaces.wake(ws.id, "relayed")],
      ["workspaces.upgrade", () => rt.workspaces.upgrade(ws.id, "relayed")],
      ["workspaces.updateImage", () => rt.workspaces.updateImage(ws.id, "relayed")],
      ["workspaces.rebuild", () => rt.workspaces.rebuild(ws.id, "relayed")],
      ["workspaces.rename", () => rt.workspaces.rename(ws.id, "mac2", "relayed")],
      ["workspaces.look", () => rt.workspaces.look(ws.id, { glyph: "flask" }, "relayed")],
      ["workspaces.snapshot", () => rt.workspaces.snapshot(ws.id, "relayed")],
      ["workspaces.updateDaemon", () => rt.workspaces.updateDaemon(ws.id, "relayed")],
      ["workspaces.delete", () => rt.workspaces.delete(ws.id, "relayed")],
      ["workspaces.forget", () => rt.workspaces.forget(ws.id, "relayed")],
      ["workspaces.touch", () => rt.workspaces.touch(ws.id, "relayed")],
      ["workspaces.exec", () => rt.workspaces.exec(ws.id, "true", undefined, "relayed")],
      ["workspaces.execStream", () => rt.workspaces.execStream(ws.id, ["true"], undefined, "relayed")],
      ["workspaces.daemonReach", () => rt.workspaces.daemonReach(ws.id, "relayed")],
      ["workspaces.portReach", () => rt.workspaces.portReach(ws.id, 3000, "relayed")],
      ["workspaces.portProbe", () => rt.workspaces.portProbe(ws.id, 3000, "relayed")],
      ["sessions.start", () => rt.sessions.start(ws.id, { prompt: "hi" }, "relayed")],
      ["sessions.history", () => rt.sessions.history(ws.id, "relayed")],
      ["sessions.list", () => rt.sessions.list(ws.id, "relayed")],
      ["sessions.interrupt", () => rt.sessions.interrupt(sessionId, "relayed")],
      ["sessions.steer", () => rt.sessions.steer(sessionId, { prompt: "hi" }, "relayed")],
      ["sessions.rename", () => rt.sessions.rename(sessionId, "a name", "relayed")],
      ["harnesses.list", () => rt.harnesses.list(ws.id, "relayed")],
      ["projects.import", () => rt.projects.import({ workspaceId: ws.id, source: "/s", dest: "/d", bundler }, "relayed")],
      ["projects.export", () => rt.projects.export({ workspaceId: ws.id, source: "/s", dest: "/d", lander }, "relayed")],
      ["status.history", () => rt.status.history(ws.id, "relayed")],
    ];
    // Every verb is asked, so a verb that stops refusing is named rather than hidden behind the first failure.
    const answered: string[] = [];
    for (const [name, call] of verbs) {
      const said = await call().then(() => "answered it", (e: unknown) => (e instanceof Error ? e.message : String(e)));
      if (said !== relayedRefusal("mac")) answered.push(`${name}: ${said}`);
    }
    expect(answered).toEqual([]);
    // Recording one is refused by the rule about who records a machine, not by the kind: its own sentence, since a
    // relayed request may not make a workspace of any kind on this computer.
    await expect(createOn(rt, { on: HERE_PLACE_ID, name: "mac2" }, "relayed")).rejects.toThrow(relayedRecordRefusal("mac2"));
    // Nothing was driven: the workspace is still there under its own name, and a request from this computer runs.
    expect((await rt.workspaces.get(ws.id)).name).toBe("mac");
    expect((await rt.sessions.start(ws.id, { prompt: "hi" }, "here").then(h => h.finished)).status).toBe("completed");
  });

  it("import on this computer registers the folder at its own path and copies nothing: the result carries the size the plan read, the events say so, and the daemon's roots file names it beside the workspace's own project", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const folder = join(root, "spoo");
    mkdirSync(folder);
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const calls: string[] = [];
    const bundler: ProjectImportOptions["bundler"] = {
      plan: async () => {
        calls.push("plan");
        return { source: folder, repo: true, files: 3, bytes: 900, secrets: [], excluded: ["node_modules"], skipped: [], agents: [] };
      },
      pack: async () => {
        throw new Error("nothing is packed on this computer");
      },
      packState: async () => {
        throw new Error("no agent state travels on this computer");
      },
    };
    const landed = await rt.projects.import({ workspaceId: ws.id, source: folder, dest: folder, bundler });
    expect(landed).toEqual({ dest: folder, files: 3, bytes: 900, parts: 0, cut: [], rewritten: [], agents: [], project: { name: "spoo", dest: folder, importedAt: expect.any(String), size: 900 } });
    expect(calls).toEqual(["plan"]);
    const stages = events.filter((e): e is ProjectImportEvent => e.type === "project.import");
    expect(stages.map(e => [e.stage, e.message])).toEqual([
      ["landing", REGISTERING_LINE],
      ["done", registeredLine(folder)],
    ]);
    // The record names the one project the workspace was made for; an import beside it adds no second one.
    const held = (await rt.workspaces.get(ws.id)).project;
    expect(held.path).not.toBe(folder);
    // The roots file is the one the wiring named, which a host keeps beside the state file it serves rather than
    // under the home its daemon browses, and it names the workspace's own project and the folder just landed.
    expect(readFileSync(localWiring.rootsPath, "utf8")).toBe(`${held.path}\n${folder}\n`);
    await rt.close();
  });

  it("a cloud workspace takes a relayed request, so the rule is the kind's and not the verb's", async () => {
    const rt = runtime();
    const cloud = await createOn(rt, { golden: "snap_g", name: "b1" }, "relayed");
    expect((await rt.workspaces.get(cloud.id, "relayed")).name).toBe("b1");
    await rt.workspaces.touch(cloud.id, "relayed");
  });

  it("the lists served to a relayed request leave the local workspace and its threads out", async () => {
    const rt = runtime();
    const local = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const cloud = await createOn(rt, { golden: "snap_g", name: "b1" });
    await (await rt.sessions.start(local.id, { prompt: "hi" })).finished;
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["b1", "mac"]);
    expect((await rt.workspaces.list("relayed")).map(w => w.name)).toEqual(["b1"]);
    expect((await rt.status.list()).map(w => w.name).sort()).toEqual(["b1", "mac"]);
    expect((await rt.status.list(undefined, "relayed")).map(w => w.name)).toEqual(["b1"]);
    expect((await rt.sessions.list()).map(v => v.workspaceId)).toEqual([local.id]);
    expect(await rt.sessions.list(undefined, "relayed")).toEqual([]);
  });

  it("origin rides the wire on every verb, not only on a thread start", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    try {
      const c = await WsClient.connect(srv.port, { token: "secret" });
      const napped = await c.request("workspaces.nap", { workspaceId: ws.id, origin: "relayed" });
      expect(napped.ok).toBe(false);
      expect(napped["error"]).toBe(relayedRefusal("mac"));
      expect((await c.request("workspaces.list", { origin: "relayed" }))["workspaces"]).toEqual([]);
      // A client on this computer names no origin, and the workspace answers it.
      expect((await c.request("workspaces.list"))["workspaces"]).toHaveLength(1);
      expect((await c.request("workspaces.rename", { workspaceId: ws.id, name: "mini", origin: "relayed" }))["error"]).toBe(relayedRefusal("mac"));
      c.close();
    } finally {
      await srv.close();
    }
  });

  it("a machine's socket is stamped relayed by the host, whatever origin its client sends", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    try {
      const here = await WsClient.connect(srv.port, { token: "secret" });
      const relay = await here.request("ticket.issue", { purpose: "relay" });
      const machine = await WsClient.connect(srv.port, { ticket: relay["ticket"] as string });
      // The client fills the field in with this computer's own word; the road it arrived on answers for it instead.
      expect((await machine.request("workspaces.get", { workspaceId: ws.id, origin: "here" }))["error"]).toBe(relayedRefusal("mac"));
      expect((await machine.request("workspaces.list", { origin: "here" }))["workspaces"]).toEqual([]);
      // Nor can it mint itself a ticket to come back as one of the person's own clients.
      expect((await machine.request("ticket.issue", { purpose: "connect" }))["error"]).toBe(RELAY_TICKET_REFUSAL);
      // The same ticket road with a connect purpose is a client of the person's own, and the workspace answers it.
      const connect = await here.request("ticket.issue", { purpose: "connect" });
      const mine = await WsClient.connect(srv.port, { ticket: connect["ticket"] as string });
      expect((await mine.request("workspaces.get", { workspaceId: ws.id }))["workspace"]).toMatchObject({ name: "mac" });
      // The door reads the table, not the wire: a socket on a connect ticket is this computer's own whatever its
      // frames claim, so the workspace answers it even when it says it is relayed.
      expect((await mine.request("workspaces.get", { workspaceId: ws.id, origin: "relayed" }))["workspace"]).toMatchObject({ name: "mac" });
      // Every purpose the table holds names an origin, so no socket is ever let in on the origin its client picked.
      expect(TICKET_ORIGIN).toEqual({ connect: "here", relay: "relayed" });
      here.close();
      machine.close();
      mine.close();
    } finally {
      await srv.close();
    }
  });

  it("a paired computer's socket is stamped paired by the host, whatever origin its client sends", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const here = await WsClient.connect(srv.port, { token: "secret" });
      const code = (await here.request("pair.issue"))["code"] as string;
      // The socket that spends the code is that computer from its next frame on, so the road is read there and
      // not only at an auth frame: a redeem is the other way in.
      const spending = await WsClient.connect(srv.port);
      const { deviceToken } = (await spending.request("pair.redeem", { code, name: "laptop" })) as { deviceToken: string };
      expect((await spending.request("workspaces.exec", { workspaceId: ws.id, argv: ["true"] }))["error"]).toBe(deviceHeldRefusal("workspaces.exec"));
      spending.close();

      const paired = await WsClient.connect(srv.port, { token: deviceToken });
      // The client fills the field in with this computer's own word; the road it arrived on answers for it instead.
      expect((await paired.request("workspaces.exec", { workspaceId: ws.id, argv: ["true"], origin: "here" }))["error"]).toBe(deviceHeldRefusal("workspaces.exec"));
      expect((await paired.request("sessions.start", { workspaceId: ws.id, prompt: "hi", origin: "here" }))["error"]).toBe(deviceHeldRefusal("sessions.start"));
      expect((await paired.request("daemon.open", { workspaceId: ws.id, origin: "here" }))["error"]).toBe(deviceHeldRefusal("daemon.open"));
      // Nothing ran: no thread stands on that workspace and the command left no run behind.
      expect(await rt.sessions.list()).toEqual([]);
      // What that computer does with this workspace otherwise is what it always did.
      expect(((await paired.request("workspaces.list"))["workspaces"] as { name: string }[]).map(w => w.name)).toEqual(["mac"]);
      expect((await paired.request("workspaces.get", { workspaceId: ws.id }))["workspace"]).toMatchObject({ name: "mac" });
      expect((await paired.request("workspaces.touch", { workspaceId: ws.id })).ok).toBe(true);
      paired.close();

      // A token the host minted into a turn's launch is still stamped relayed, and reads that rule's own sentence.
      const thread = await rt.devices.mint("thread abcd1234", { kind: "thread", threadId: "t_1", workspaceId: ws.id, rootThreadId: "t_1" }, Date.now());
      const machine = await WsClient.connect(srv.port, { token: thread.deviceToken });
      expect((await machine.request("workspaces.exec", { workspaceId: ws.id, argv: ["true"] }))["error"]).toBe(noWorkspaceRefusal());
      machine.close();

      // The host's own socket carries the word its client sends, which is what it always did, and starts one.
      expect((await here.request("workspaces.exec", { workspaceId: ws.id, argv: ["true"], origin: "relayed" }))["error"]).toBe(relayedRefusal("mac"));
      const ran = await here.request("workspaces.exec", { workspaceId: ws.id, argv: ["true"] });
      expect(ran.ok).toBe(true);
      // Read to its end, so the run this case started is over before the case's folder goes.
      await until(() => here.events.some(e => e.type === "exec.exit" && e["execId"] === ran["execId"]));
      here.close();
    } finally {
      await srv.close();
      await rt.close();
    }
  });

  it("a computer the person paired is refused every op outside the device list at the door, on every kind of workspace, and nothing runs", async () => {
    const rt = runtime();
    const mac = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const cloud = await createOn(rt, { golden: "snap_g", name: "b1" });
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const here = await WsClient.connect(srv.port, { token: "secret" });
      const code = (await here.request("pair.issue"))["code"] as string;
      const spending = await WsClient.connect(srv.port);
      const { deviceToken } = (await spending.request("pair.redeem", { code, name: "laptop" })) as { deviceToken: string };
      spending.close();
      const paired = await WsClient.connect(srv.port, { token: deviceToken });
      // Every op that starts or puts a hand on a process, on this computer's workspace and on a fork alike: the list
      // is the rule, not the kind, so a device that may not start a thread here may not start one on a box either.
      const held: [string, Record<string, unknown>][] = [];
      for (const ws of [mac, cloud]) {
        held.push(
          ["sessions.start", { workspaceId: ws.id, prompt: "hi" }],
          ["sessions.steer", { sessionId: "s_none", prompt: "and this" }],
          ["workspaces.exec", { workspaceId: ws.id, argv: ["true"] }],
          ["workspaces.bringBack", { workspaceId: ws.id }],
          ["daemon.open", { workspaceId: ws.id }],
        );
      }
      held.push(["daemon.open", { placeId: "pl_box" }], ["sessions.answer", { sessionId: "s_none", askId: "a1", optionId: "yes" }], ["sessions.access", { sessionId: "s_none", permissionMode: "bypassPermissions" }]);
      // The door is read before the frame's shape is, so a held op with a frame the schema would refuse reads the
      // held sentence and not the names of the fields it lacks.
      held.push(["sessions.start", { prompt: "hi" }]);
      const answered: string[] = [];
      for (const [op, frame] of held) {
        const reply = await paired.request(op, frame);
        if (reply["error"] !== deviceHeldRefusal(op)) answered.push(`${op}: ${String(reply["error"] ?? "answered it")}`);
      }
      expect(answered).toEqual([]);
      // Nothing ran: no thread stands anywhere and no command left a run behind.
      expect(await rt.sessions.list()).toEqual([]);
      // What that computer lists, reads, watches and manages is what it always was.
      expect(((await paired.request("workspaces.list"))["workspaces"] as { name: string }[]).map(w => w.name).sort()).toEqual(["b1", "mac"]);
      expect(((await paired.request("status.list"))["statuses"] as { name: string }[]).map(w => w.name).sort()).toEqual(["b1", "mac"]);
      expect((await paired.request("sessions.list")).ok).toBe(true);
      expect((await paired.request("devices.list")).ok).toBe(true);
      const made = await paired.request("workspaces.create", { project: cloud.project.id, name: "b2", golden: "snap_g" });
      expect(made.ok, String(made["error"])).toBe(true);
      paired.close();
      // The rule left the runtime for the door: a start asked of the runtime itself under the paired word runs, which
      // is the road a line registered by an older host takes and the one the delivery below reads for itself.
      expect((await rt.sessions.start(mac.id, { prompt: "hi" }, "paired").then(h => h.finished)).status).toBe("completed");
      here.close();
    } finally {
      await srv.close();
      await rt.close();
    }
  });

  it("a computer the person paired is refused a thread's rename on a workspace here, since a rename runs a shell on the machine and writes the person's agent session file", async () => {
    const rt = runtime();
    const mac = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const thread = await rt.sessions.start(mac.id, { prompt: "hi" });
      await thread.finished;
      const here = await WsClient.connect(srv.port, { token: "secret" });
      const code = (await here.request("pair.issue"))["code"] as string;
      const spending = await WsClient.connect(srv.port);
      const { deviceToken } = (await spending.request("pair.redeem", { code, name: "laptop" })) as { deviceToken: string };
      spending.close();
      const paired = await WsClient.connect(srv.port, { token: deviceToken });
      expect((await paired.request("sessions.rename", { sessionId: thread.id, title: "renamed" }))["error"]).toBe(deviceHeldRefusal("sessions.rename"));
      expect((await rt.sessions.list(mac.id)).every(row => row.titleSource !== "person")).toBe(true);
      // The workspace's own rename writes a record of wsp's and nothing else, so it stays that computer's to ask.
      const renamed = await paired.request("workspaces.rename", { workspaceId: mac.id, name: "renamed" });
      expect(renamed.ok, String(renamed["error"])).toBe(true);
      paired.close();
      here.close();
    } finally {
      await srv.close();
      await rt.close();
    }
  });

  it("a ticket a paired computer minted opens a paired socket, so a second frame is no way around the rule", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const here = await WsClient.connect(srv.port, { token: "secret" });
      const code = (await here.request("pair.issue"))["code"] as string;
      const spending = await WsClient.connect(srv.port);
      const { deviceToken } = (await spending.request("pair.redeem", { code, name: "laptop" })) as { deviceToken: string };
      spending.close();

      const paired = await WsClient.connect(srv.port, { token: deviceToken });
      const ticket = (await paired.request("ticket.issue", { purpose: "connect" }))["ticket"] as string;
      paired.close();
      // A ticket carries the road of the socket that minted it, so the socket it lets in is that computer too.
      const second = await WsClient.connect(srv.port, { ticket });
      expect((await second.request("workspaces.exec", { workspaceId: ws.id, argv: ["true"] }))["error"]).toBe(deviceHeldRefusal("workspaces.exec"));
      expect((await second.request("sessions.start", { workspaceId: ws.id, prompt: "hi" }))["error"]).toBe(deviceHeldRefusal("sessions.start"));
      // What that socket reads is unchanged, as it is on the device's own.
      expect(((await second.request("workspaces.list"))["workspaces"] as { name: string }[]).map(w => w.name)).toEqual(["mac"]);
      second.close();

      // A relay ticket a paired computer mints is stricter still: that word says the request came from a machine.
      const pairedAgain = await WsClient.connect(srv.port, { token: deviceToken });
      const relay = (await pairedAgain.request("ticket.issue", { purpose: "relay" }))["ticket"] as string;
      pairedAgain.close();
      const asMachine = await WsClient.connect(srv.port, { ticket: relay });
      expect((await asMachine.request("workspaces.exec", { workspaceId: ws.id, argv: ["true"] }))["error"]).toBe(relayedRefusal("mac"));
      asMachine.close();

      // The person's own connect ticket is what it always was: a socket on one starts a command here.
      const mine = (await here.request("ticket.issue", { purpose: "connect" }))["ticket"] as string;
      const own = await WsClient.connect(srv.port, { ticket: mine });
      const ran = await own.request("workspaces.exec", { workspaceId: ws.id, argv: ["true"] });
      expect(ran.ok).toBe(true);
      await until(() => own.events.some(e => e.type === "exec.exit" && e["execId"] === ran["execId"]));
      own.close();
      here.close();
    } finally {
      await srv.close();
      await rt.close();
    }
  });

  it("a line registered from a paired computer falls away to the person at its delivery, and the road it was named from rides beside the target", async () => {
    const noting = notingAdapter();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: noting.factory }, local: localWiring });
    const mac = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const cloud = await createOn(rt, { golden: "snap_g", name: "b1" });
    // The owner's own thread on this computer, idle, which is the session a line would resume under their login.
    const own = await rt.sessions.start(mac.id, { prompt: "coordinate" });
    await own.finished;
    const onThisComputer = own.view().threadId!;
    // The door is what refuses a paired socket a start, so a start asked of the runtime under that word, which is
    // what a row an older host wrote carries, registers the target and keeps the road beside it.
    const lead = await rt.sessions.start(cloud.id, { prompt: "lead", notify: [onThisComputer] }, "paired");
    await lead.finished;
    const leadThread = lead.view().threadId!;
    // At the delivery the road is read against the device list: the line goes to the person, once, and the
    // owner's thread on this computer never runs again.
    await until(async () => (await rt.sessions.history(cloud.id)).some(e => e.type === "session.notify" && e.threadId === leadThread && (e as { notify: string }).notify === NOTIFY_ME));
    expect(noting.starts).toEqual([{ prompt: "coordinate" }, { prompt: "lead" }]);
    const startsHere = (await rt.sessions.history(mac.id)).filter(e => e.type === "session.start").length;
    expect(startsHere).toBe(1);
    const kept = (await store.get("sessions", cloud.id)) as { sessions: { notifyRoad?: string }[] };
    expect(kept.sessions.filter(row => row.notifyRoad !== undefined).map(row => row.notifyRoad)).toEqual(["paired"]);
    await rt.close();
  });

  it("status.list reads the same origin rule as every other listing, and hands over the state without the route the reach carries", async () => {
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: { ...localWiring, daemonRoad: async () => ({ url: `http://127.0.0.1:${probe.port}`, expiresAt: Number.MAX_SAFE_INTEGER }) } });
    await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await createOn(rt, { golden: "snap_g", name: "b1" });
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    type Row = { name: string; reach: Record<string, unknown> };
    try {
      const here = await WsClient.connect(srv.port, { token: "secret" });
      const mine = (await here.request("status.list"))["statuses"] as Row[];
      expect(mine.map(r => r.name).sort()).toEqual(["b1", "mac"]);
      // The runtime dialled the road and knows the route; no door but the app's own socket is handed it.
      expect((await rt.status.list()).find(s => s.name === "mac")!.reach.url).toBe(`http://127.0.0.1:${probe.port}`);
      for (const row of mine) expect(Object.keys(row.reach)).toEqual(["state"]);
      expect(mine.find(r => r.name === "mac")!.reach["state"]).toBe("reachable");

      const relay = await here.request("ticket.issue", { purpose: "relay" });
      const machine = await WsClient.connect(srv.port, { ticket: relay["ticket"] as string });
      // The origin the frame claims changes nothing: the road it arrived on answers for it, as on every other verb.
      const relayed = (await machine.request("status.list", { origin: "here" }))["statuses"] as Row[];
      expect(relayed.map(r => r.name)).toEqual(["b1"]);
      for (const row of relayed) expect(Object.keys(row.reach)).toEqual(["state"]);
      here.close();
      machine.close();
    } finally {
      await srv.close();
      await rt.close();
    }
  });

  it("the port forwards the host holds read the same rule: a relayed request neither lists nor stops one on this computer", async () => {
    const rt = runtime();
    const local = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const cloud = await createOn(rt, { golden: "snap_g", name: "b1" });
    const row = (workspaceId: string, port: number, name: string): PortForward => ({ workspaceId, port, startedAt: "2026-09-08T00:00:00.000Z", name, kind: "url" });
    // The host forwards a builder's ports too, and no workspace record names a builder.
    const rows = [row(local.id, 8123, "mac"), row(cloud.id, 8124, "b1"), row("m_builder", 8125, "setup (builder)")];
    const stops: string[] = [];
    const forwards: ForwardsSource = {
      list: () => rows,
      stop: (workspaceId, port) => {
        stops.push(`${workspaceId}:${port}`);
        return true;
      },
      on: () => () => {},
    };
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", forwards });
    try {
      const c = await WsClient.connect(srv.port, { token: "secret" });
      const ports = async (params?: Record<string, unknown>): Promise<number[]> => ((await c.request("forwards.list", params))["forwards"] as PortForward[]).map(f => f.port);
      const stopped = async (workspaceId: string, port: number): Promise<string> => (await c.request("forwards.stop", { workspaceId, port, origin: "relayed" }))["error"] as string ?? "stopped it";
      // Both halves are read before anything is asserted, so a half that stops holding is named rather than hidden.
      const seen = {
        listedHere: await ports(),
        listedRelayed: await ports({ origin: "relayed" }),
        localStop: await stopped(local.id, 8123),
        cloudStop: await stopped(cloud.id, 8124),
        builderStop: await stopped("m_builder", 8125),
        asked: stops,
      };
      expect(seen).toEqual({
        listedHere: [8123, 8124, 8125],
        listedRelayed: [8124, 8125],
        localStop: relayedRefusal("mac"),
        cloudStop: "stopped it",
        builderStop: "stopped it",
        asked: [`${cloud.id}:8124`, "m_builder:8125"],
      });
      c.close();
    } finally {
      await srv.close();
    }
  });

  it("delete drops the record and nothing else; the computer is not stopped", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await rt.workspaces.delete(ws.id);
    expect(await rt.workspaces.list()).toEqual([]);
    // The record survives a delete only in the store's absence of it; a fresh runtime lists none.
    const rt2 = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: localWiring });
    expect(await rt2.workspaces.list()).toEqual([]);
  });

  it("the local workspace survives a runtime restart, hydrated straight off the local backend as running", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const rt2 = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: localWiring });
    const listed = await rt2.workspaces.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: ws.id, kind: "local", phase: "running" });
    // A thread still runs on it after the restart.
    const handle = await rt2.sessions.start(ws.id, { prompt: "again" });
    expect((await handle.finished).text).toBe("pong");
  });

  it("the local row's rate is zero: its rate follows the local backend's pricing, not the cloud one's", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const status = (await rt.status.list()).find(s => s.id === ws.id)!;
    expect(status.rateUsdPerHour).toBe(0);
    expect(status.kind).toBe("local");
  });

  it("the local row's status carries this computer's facts: the system's name, its uptime and the folder its commands start in; a cloud row carries none", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const cloud = await createOn(rt, { golden: "snap_g", name: "b1" });
    const statuses = await rt.status.list();
    const local = statuses.find(s => s.id === ws.id)!;
    expect(local.facts).toBeDefined();
    expect(local.facts!.os).not.toBe("");
    expect(local.facts!.uptimeMs).toBeGreaterThan(0);
    expect(local.facts!.folder).toBe(root);
    expect(statuses.find(s => s.id === cloud.id)!.facts).toBeUndefined();
  });

  it("the panes dial this computer's own daemon: workspaces.daemonReach hands out the road the host wired", async () => {
    const road = { url: "http://127.0.0.1:54321", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t0ken" };
    localWiring = { ...localWiring, daemonRoad: async () => road };
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    expect(await rt.workspaces.daemonReach(ws.id)).toEqual(road);
  });

  it("the button under the panes asks the host for another daemon, which only this computer's workspace has", async () => {
    let started = 0;
    localWiring = { ...localWiring, restartDaemon: async () => void started++, daemonRoad: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }) };
    const rt = runtime();
    const here = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));
    await rt.workspaces.restartDaemon(here.id);
    expect(started).toBe(1);
    // The row says what this host has just watched start, rather than the poll's reading of the daemon that is
    // gone: a person who pressed the button read no daemon under it for another ten seconds.
    const said = statuses.filter(s => s.id === here.id).at(-1);
    expect(said?.reach.state).toBe("reachable");
    // Every other kind's daemon runs on a machine this host reaches and does not hold the process of.
    const cloud = await createOn(rt, { golden: "snap_g", name: "fork" });
    await expect(rt.workspaces.restartDaemon(cloud.id)).rejects.toThrow(/does not hold the process of/);
  });

  it("says a host that wires no such road cannot start one, rather than answering the button with nothing", async () => {
    const rt = runtime();
    const here = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await expect(rt.workspaces.restartDaemon(here.id)).rejects.toThrow(/does not hold the process of/);
  });

  it("a host that wired no daemon for this computer says so rather than minting a preview route", async () => {
    const rt = runtime();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await expect(rt.workspaces.daemonReach(ws.id)).rejects.toThrow("wired no daemon for its local workspace");
  });

  it("the status probe reads the local road: reachable with one wired, unsupported without", async () => {
    const withRoad = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: { ...localWiring, daemonRoad: async () => ({ url: `http://127.0.0.1:${probe.port}`, expiresAt: Number.MAX_SAFE_INTEGER }) } });
    const dialled = await createOn(withRoad, { on: HERE_PLACE_ID, name: "mac" });
    expect((await withRoad.status.list()).find(s => s.id === dialled.id)!.reach.state).toBe("reachable");
    await withRoad.close();
    const bare = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: echoAdapter }, local: localWiring });
    const alone = await createOn(bare, { on: HERE_PLACE_ID, name: "mac" });
    expect((await bare.status.list()).find(s => s.id === alone.id)!.reach.state).toBe("unsupported");
    await bare.close();
  });

  it("closing the runtime frees what the local wiring holds open on this computer", async () => {
    let closed = 0;
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: { ...localWiring, close: async () => void closed++ } });
    await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await rt.close();
    expect(closed).toBe(1);
  });

  it("this computer holds no machine slot: at the cap one cloud record still leaves a slot, and the refusal never names the local row", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store, adapters: { claude: echoAdapter }, local: localWiring });
    await createOn(rt, { on: HERE_PLACE_ID, name: "zingzys-MacBook-Pro.local" });
    await createOn(rt, { golden: "snap_g", name: "b2" });
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
      return create(spec);
    };
    const refused = await createOn(rt, { golden: "snap_g", name: "b3" }).catch((e: unknown) => e);
    expect((refused as Error).message).toBe("a machine slot is in use: b2. Pause it or wait for a nap.");
  });

  it("with no cloud record at all the refusal claims no holder, since this computer holds none", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store, adapters: { claude: echoAdapter }, local: localWiring });
    await createOn(rt, { on: HERE_PLACE_ID, name: "zingzys-MacBook-Pro.local" });
    backend.create = async () => {
      throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
    };
    const refused = await createOn(rt, { golden: "snap_g", name: "b1" }).catch((e: unknown) => e);
    expect((refused as Error).message).toBe("the provider is at its machine cap and no machine of this computer holds a slot; free one at the provider and try again");
  });

  it("createLocal is refused when no local backend is wired", async () => {
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter } });
    await expect(createOn(rt, { on: HERE_PLACE_ID, name: "mac" })).rejects.toThrow("no local backend wired");
  });
});

describe("a local turn and a host restart", () => {
  let root: string;
  let runDir: string;
  let store: Store;
  let localWiring: LocalWiring;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localcut-"));
    runDir = join(root, "runs");
    store = memoryStore();
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir, ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    sweepStrays();
  });

  /** An adapter whose turn is a real run on this computer, read through the factory its kind handed it: it reports
   * the run its stream named and re-opens one an earlier host process left, which is what both shipped adapters do
   * with the factory's own attach. A line the run prints is one delta; the exit code ends the turn. */
  const runAdapter = (command: string): HarnessAdapterFactory => ctx => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const read = (stream: ExecStream, onEvent: (event: AdapterEvent) => void): HarnessSession => {
      const finished = (async () => {
        onEvent({ type: "session.start", sessionId, cwd: root });
        let text = "";
        for await (const line of stream.lines) {
          text += line;
          onEvent({ type: "turn.delta", sessionId, kind: "text", text: line });
        }
        const exitCode = await stream.exited;
        const result = { status: exitCode === 0 ? "completed" : "failed", text } as const;
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode, sawResult: true });
        return result;
      })();
      return { localId: sessionId, finished, ...(stream.run !== undefined ? { run: stream.run } : {}), interrupt: async () => {} };
    };
    const attach = ctx.execStream.attach?.bind(ctx.execStream);
    return {
      steers: false,
      start: ({ onEvent }) => read(ctx.execStream(command, { env: { ...ctx.env } }), onEvent),
      ...(attach === undefined
        ? {}
        : {
            attach: async (o: AdapterAttachOptions) => {
              const stream = await attach(o.run, { input: false });
              return stream === "gone" ? "gone" : read(stream, o.onEvent);
            },
          }),
    };
  };

  it("a local turn outlives the host that started it: the row keeps its run, stays running across the restart and the reply lands in the thread", async () => {
    const gate = join(root, "gate");
    const marker = join(root, "turn.pid");
    // A turn that prints, then waits for the file the test writes once the new host is up, then replies: every line
    // of it lands whether or not a host is reading at the time. It goes on after the reply, since this process is
    // still holding the reader the first host left and two readers would race to reap the run at its end, which is
    // an artifact of running both hosts here: a real one goes with its process.
    const rt1 = createRuntime({ backend: stubBackend(), store, adapters: { claude: runAdapter(`echo $$ > ${marker}; echo reading the ticket; while [ ! -f ${gate} ]; do sleep 0.05; done; echo wrote the fix; sleep 30`) }, local: localWiring });
    const ws = await createOn(rt1, { on: HERE_PLACE_ID, name: "mac" });
    await rt1.sessions.start(ws.id, { prompt: "build it" });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.delta"));
    await grandchild(marker);
    // The host goes with the turn still running, the way a launchctl kickstart takes it.
    await rt1.close();

    // The row keeps the handle the run is named by on this computer, which is what the next host re-opens it with.
    const stored = (await store.get("sessions", ws.id)) as { sessions: { status: string; run?: string }[] };
    expect(stored.sessions.map(s => s.status)).toEqual(["running"]);
    const runs = readdirSync(runDir).filter(name => name.endsWith(".d"));
    expect(runs).toHaveLength(1);
    expect(stored.sessions[0]!.run).toBe(join(runDir, runs[0]!.slice(0, -".d".length)));

    const rt2 = createRuntime({ backend: stubBackend(), store, adapters: { claude: runAdapter("true") }, local: localWiring });
    // No false failure on the way back: the row is handed to the new host as the running turn it is.
    expect((await rt2.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    writeFileSync(gate, "go\n");
    await until(async () => (await rt2.sessions.history(ws.id)).some(e => e.type === "session.delta" && e.text === "wrote the fix"), 20_000);
    // The run's log is read from its first byte, so the line the old host already wrote is read past rather than
    // written to the thread twice, and the reply the new host was there for lands after it.
    const history = await rt2.sessions.history(ws.id);
    expect(history.filter(e => e.type === "session.delta").map(e => e.text)).toEqual(["reading the ticket", "wrote the fix"]);
    expect((await rt2.sessions.list(ws.id))[0]!.status).toBe("running");
    await rt2.close();
  }, 30_000);

  it("a run this computer no longer holds ends its turn as cut, with the truth and no false failure in between", async () => {
    const rt1 = createRuntime({ backend: stubBackend(), store, adapters: { claude: runAdapter("sleep 30") }, local: localWiring });
    const ws = await createOn(rt1, { on: HERE_PLACE_ID, name: "mac" });
    const handle = await rt1.sessions.start(ws.id, { prompt: "build it" });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.start"));
    await rt1.close();

    // Whatever was launched is gone: the person restarted the computer, or the sweep of another host took it.
    const held = readdirSync(runDir).filter(name => name.endsWith(".d"));
    expect(held).toHaveLength(1);
    for (const name of readdirSync(runDir)) rmSync(join(runDir, name), { recursive: true, force: true });

    const rt2 = createRuntime({ backend: stubBackend(), store, adapters: { claude: runAdapter("true") }, local: localWiring });
    await until(async () => (await rt2.sessions.list(ws.id))[0]!.status === "failed");
    const history = await rt2.sessions.history(ws.id);
    expect(history.at(-1)).toMatchObject({ type: "session.end", exitCode: null, reason: RUN_GONE_LINE });
    await rt2.close();

    // The thread is not lost: the next send resumes it and says the transcript may be missing what the cut turn did.
    const rt3 = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: localWiring });
    const resumed = await rt3.sessions.start(ws.id, { prompt: "carry on", thread: handle.view().threadId });
    await resumed.finished;
    const starts = (await rt3.sessions.history(ws.id)).filter(e => e.type === "session.start");
    expect(starts.at(-1)).toMatchObject({ prompt: "carry on", afterCut: true });
    await rt3.close();
  }, 30_000);
});

describe("one registry for what a workspace's kind means", () => {
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
  /** A comparison on the kind, or a switch arm for it, anywhere in source: every road reads a capability or asks the
   * kind's module in the runtime's registry table instead. */
  const RULE = /\bkind\s*[!=]==\s*"(local|cloud|ssh)"|case "(local|cloud|ssh)":/;
  const sourceFiles = (): string[] => {
    const out: string[] = [];
    for (const top of ["packages", "apps"]) {
      for (const pkg of readdirSync(join(ROOT, top), { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue;
        let files: string[];
        try {
          files = readdirSync(join(ROOT, top, pkg.name, "src"), { recursive: true, encoding: "utf8" });
        } catch {
          continue;
        }
        for (const f of files) if (/\.tsx?$/.test(f)) out.push(join(top, pkg.name, "src", f));
      }
    }
    return out;
  };

  it("no source file compares a workspace's kind; the registry table is the one place it is read", () => {
    expect(sourceFiles().filter(rel => RULE.test(readFileSync(join(ROOT, rel), "utf8")))).toEqual([]);
  });
});
