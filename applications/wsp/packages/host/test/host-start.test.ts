// SPDX-License-Identifier: AGPL-3.0-only
// The host a verb brings up for itself: what it spawns, what it says, what it
// does when the child never serves, and which lines start one at all.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES, exitClassOf } from "@wsp/protocol";
import { cli, HOST_STARTS_ITSELF, localWiring, serve, type CliIO } from "../src/cli.js";
import { hostLogPath, lockPathFor, servingHost, startedByEnv, STARTED_BY_ENV, type HostLock } from "../src/host-lock.js";
import { hostExitedLine, hostStarter, noHostAnsweredLine, serviceServesStateLine, startingHostLine, type HostStarter } from "../src/host-start.js";
import { SERVICE_WAIT_MS } from "../src/service.js";
import { dialer } from "../src/mcp.js";
import { dialHost, noHostServingLine } from "../src/verbs.js";
import type { HostHandle } from "../src/server.js";
import { PAGE, captured } from "./verbs-fixture.js";
import { stubBackend } from "./stub-backend.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

/** The fingerprint a pairing pinned, which every record written since wsp pinned keys carries. */
const HOST_KEY = "SHA256:MVm4EO/x4dkERU6dZOt1s4N04aW619pwoUo/9Qpz40A";

runsFromItsOwnFolder();

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const quietIO = (lines: string[] = [], errors: string[] = []): CliIO => ({ log: l => lines.push(l), error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt });

/** A spawn that records the line and hands back the little of a child process the starter touches: the unref, and
 * the exit the starter watches for, which this child never reaches unless a case makes it. */
function fakeSpawn(onCall: (call: { command: string; args: readonly string[]; opts: Record<string, unknown> }) => void, exits?: { code: number | null; signal: NodeJS.Signals | null }) {
  let unrefs = 0;
  let starts = 0;
  const spawn = ((command: string, args: readonly string[], opts: Record<string, unknown>) => {
    starts++;
    onCall({ command, args, opts });
    const onExit: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    if (exits !== undefined) queueMicrotask(() => void onExit.forEach(fn => fn(exits.code, exits.signal)));
    return {
      unref: () => void unrefs++,
      once: (event: string, fn: (code: number | null, signal: NodeJS.Signals | null) => void) => {
        if (event === "exit") onExit.push(fn);
      },
    };
  }) as unknown as Parameters<typeof hostStarter>[0]["spawn"];
  return { spawn, unrefs: () => unrefs, starts: () => starts };
}

describe("a verb starts the host when none serves", () => {
  let dir: string;
  let statePath: string;
  let webDir: string;
  let rt: Runtime | undefined;
  const handles: HostHandle[] = [];
  /** Folders a case made outside its own temp dir, for the one line that wants a real git repo. */
  const repos: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-start-"));
    webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_start_key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.close();
    await rt?.close();
    rt = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    for (const folder of repos.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  /** A starter that brings the host up in this process, which is what a real one's child does in its own. */
  function servingStarter(): { start: HostStarter; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      start: async (path, say) => {
        calls.push(path);
        say(startingHostLine(path, hostLogPath(path)));
        // Wired for this computer as well as for the stub provider: wsp add on a folder here records a project on
        // this computer, and a host with no local backend refuses that rather than the dial.
        rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, local: localWiring(join(dir, "home")) });
        handles.push(await serve(captured(), { port: 0, wsPort: 0, statePath: path, webDir, runtime: rt }));
        return servingHost(path)!;
      },
    };
  }

  it("spawns this same wsp on free ports, detached, with the verb's word in its environment, and says where its log is", async () => {
    const calls: { command: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
    const lock: HostLock = { pid: process.pid, port: 1, wsPort: 2, startedAt: new Date().toISOString() };
    mkdirSync(join(dir, "state"), { recursive: true });
    // The child takes the lock, as a real one does, and the wait finds it there.
    const fake = fakeSpawn(call => {
      calls.push(call);
      writeFileSync(lockPathFor(statePath), JSON.stringify(lock));
    });
    const start = hostStarter({
      spawn: fake.spawn,
      wsp: { command: "/usr/local/bin/wsp", args: [] },
      env: { PATH: "/bin" },
      waitMs: 2_000,
      answers: () => Promise.resolve(true),
      registered: () => undefined,
    });
    const said: string[] = [];
    expect(await start(statePath, line => said.push(line))).toEqual(lock);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/usr/local/bin/wsp");
    expect(calls[0]!.args).toEqual(["up", "--state", statePath, "--port", "0", "--ws-port", "0"]);
    expect(calls[0]!.opts["detached"]).toBe(true);
    expect((calls[0]!.opts["env"] as Record<string, string>)[STARTED_BY_ENV]).toBe("verb");
    expect(fake.unrefs()).toBe(1);
    expect(said).toEqual([`starting the host for ${statePath}; its log is ${hostLogPath(statePath)}, and wsp down stops it`]);
  });

  it("a host that restarts itself on the verb's road starts its child on the ports it held, so a tab on them reconnects", async () => {
    const calls: { args: readonly string[] }[] = [];
    const lock: HostLock = { pid: process.pid, port: 7101, wsPort: 7102, startedAt: new Date().toISOString() };
    mkdirSync(join(dir, "state"), { recursive: true });
    const fake = fakeSpawn(call => {
      calls.push(call);
      writeFileSync(lockPathFor(statePath), JSON.stringify(lock));
    });
    const start = hostStarter({ spawn: fake.spawn, wsp: { command: "wsp", args: [] }, env: {}, waitMs: 2_000, answers: () => Promise.resolve(true), registered: () => undefined });
    expect(await start(statePath, () => undefined, { port: 7101, wsPort: 7102 })).toEqual(lock);
    expect(calls[0]!.args).toEqual(["up", "--state", statePath, "--port", "7101", "--ws-port", "7102"]);
  });

  it("a child that never serves is one refusal naming the state file, the log's last lines under it, of the provider class", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(hostLogPath(statePath), "Error: EADDRINUSE 4400\n");
    const fake = fakeSpawn(() => {});
    const start = hostStarter({ spawn: fake.spawn, wsp: { command: "wsp", args: [] }, env: {}, waitMs: 0, answers: () => Promise.resolve(false), registered: () => undefined });
    const refused = await start(statePath, () => {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message.split("\n")).toEqual([noHostAnsweredLine(statePath, 0), "Error: EADDRINUSE 4400"]);
    expect(exitClassOf(refused)).toBe("provider");
  });

  it("a child that exits before it serves is read once and at once, with every line it wrote and none of an older start's", async () => {
    // The wall this rule is from: a host that refused its state at boot died in under a second, and the line that
    // started it waited the whole twenty seconds and then said no host answered, with the refusal wrapped in a
    // tail of lines from days before.
    mkdirSync(join(dir, "state"), { recursive: true });
    const logPath = hostLogPath(statePath);
    writeFileSync(logPath, "an older start's refusal\n");
    const refusal = ["the state was written by a newer wsp", "run that wsp, or move the file aside"];
    const fake = fakeSpawn(() => appendFileSync(logPath, `${refusal.join("\n")}\n`), { code: 1, signal: null });
    const start = hostStarter({
      spawn: fake.spawn,
      wsp: { command: "wsp", args: [] },
      env: {},
      waitMs: SERVICE_WAIT_MS,
      answers: () => Promise.resolve(false),
      registered: () => undefined,
    });
    const said: string[] = [];
    vi.useFakeTimers();
    try {
      const refused = await start(statePath, line => said.push(line)).catch((e: unknown) => e);
      // The refusal the child wrote, both of its lines, and nothing of the wait or of the start before it.
      expect((refused as Error).message.split("\n")).toEqual(refusal);
      expect((refused as Error).message).not.toContain("an older start's refusal");
      expect((refused as Error).message).not.toContain("no host answered");
      expect(said).toEqual([startingHostLine(statePath, logPath)]);
      expect(fake.starts()).toBe(1);
      // Nothing sleeps on to the deadline: the poll's timer went with the child.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a child that exits having written nothing is one sentence naming how it ended and where its log is", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    const fake = fakeSpawn(() => {}, { code: 3, signal: null });
    const start = hostStarter({ spawn: fake.spawn, wsp: { command: "wsp", args: [] }, env: {}, waitMs: SERVICE_WAIT_MS, answers: () => Promise.resolve(false), registered: () => undefined });
    const refused = await start(statePath, () => {}).catch((e: unknown) => e);
    expect((refused as Error).message).toBe(hostExitedLine(statePath, 3, hostLogPath(statePath)));
    expect(exitClassOf(refused)).toBe("provider");
  });

  it("a line whose host exits refusing the state prints the starting line and that refusal, and starts one host", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    const logPath = hostLogPath(statePath);
    const refusal = "the state was written by a newer wsp; run that wsp, or move the file aside";
    const fake = fakeSpawn(() => appendFileSync(logPath, `${refusal}\n`), { code: 1, signal: null });
    const start = hostStarter({ spawn: fake.spawn, wsp: { command: "wsp", args: [] }, env: {}, waitMs: SERVICE_WAIT_MS, answers: () => Promise.resolve(false), registered: () => undefined });
    const errors: string[] = [];
    expect(await cli(["workspaces", "--state", statePath], quietIO([], errors), undefined, {}, start)).toBe(EXIT_CODES.provider);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(startingHostLine(statePath, logPath));
    expect(errors[1]).toContain(refusal);
    expect(errors[1]).not.toContain("no host answered");
    expect(fake.starts()).toBe(1);
  });

  it("the dial starts one for a host on this computer and never for a host somewhere else, and starts none when the line hands none in", async () => {
    const here = servingStarter();
    const client = await dialHost(statePath, { aim: { kind: "here" }, start: here.start, say: () => {} });
    client.close();
    expect(here.calls).toEqual([statePath]);
    // A host it already found is not started again.
    const again = await dialHost(statePath, { aim: { kind: "here" }, start: here.start, say: () => {} });
    again.close();
    expect(here.calls).toEqual([statePath]);

    const there = servingStarter();
    const nowhere = { kind: "alias" as const, alias: "box", record: { url: "http://127.0.0.1:1", deviceToken: "tok", deviceId: "d1", hostKey: HOST_KEY, pairedAt: new Date().toISOString(), via: { kind: "account" as const, hostId: "hbox" } } };
    await expect(dialHost(statePath, { aim: nowhere, start: there.start, deadlineMs: 500 })).rejects.toThrow();
    expect(there.calls).toEqual([]);

    for (const h of handles.splice(0)) await h.close();
    await rt?.close();
    rt = undefined;
    await expect(dialHost(join(dir, "other", "state.json"), { aim: { kind: "here" } })).rejects.toThrow(noHostServingLine(join(dir, "other", "state.json")));
  });

  it("a line that starts nothing reads the refusal with the line that serves that file, and exits non-zero", async () => {
    // Priya's and Marco's first stall, at their second command: a fact with no next step in it, where every other
    // refusal in wsp ends with the command that fixes it. The flag is spelled out, since a person who named a
    // state file has to name it again to serve that one.
    const elsewhere = join(dir, "other", "state.json");
    expect(noHostServingLine(elsewhere)).toBe(`no wsp host is serving ${elsewhere}; start one with wsp up --state ${elsewhere}`);
    const errors: string[] = [];
    // A line handed no starter, which is what a caller that wants the refusal rather than a host hands in.
    expect(await cli(["add", dir, "--state", elsewhere], quietIO([], errors), undefined, {}, false)).toBe(EXIT_CODES.provider);
    expect(errors).toEqual([noHostServingLine(elsewhere)]);
  });

  it("wsp add and wsp remove start the host too, so the front page's claim holds for the second command a person types", async () => {
    // Both testers typed wsp add second and read a refusal, while every verb around it starts a host for itself.
    // The claim on the front page is now true of these two as well, and it is that claim this proves.
    expect(HOST_STARTS_ITSELF).toBe("A line that needs a host starts one when none serves.");
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-start-repo-")));
    repos.push(folder);
    execFileSync("git", ["init", "-q", folder]);
    const here = servingStarter();
    const lines: string[] = [];
    const errors: string[] = [];
    expect(await cli(["add", folder, "--state", statePath], quietIO(lines, errors), undefined, {}, here.start), errors.join("\n")).toBe(0);
    expect(here.calls).toEqual([statePath]);
    expect(errors).toEqual([startingHostLine(statePath, hostLogPath(statePath))]);
    expect(lines.join("\n")).toContain(folder);
    // And the other of the two words, which dials the same way: the host is up now, so this one starts none and
    // the refusal it reads is about the computer it was asked for, not about a host.
    const removing: string[] = [];
    expect(await cli(["remove", "nowhere", "--state", statePath], quietIO([], removing), undefined, {}, here.start)).toBe(1);
    expect(here.calls).toEqual([statePath]);
    expect(removing.join("\n")).not.toContain("no wsp host is serving");
  });

  it("wsp threads with no host starts one, says so on stderr, and prints the answer on stdout", async () => {
    const here = servingStarter();
    const lines: string[] = [];
    const errors: string[] = [];
    expect(await cli(["threads", "--json", "--state", statePath], quietIO(lines, errors), undefined, {}, here.start)).toBe(0);
    expect(here.calls).toEqual([statePath]);
    expect(errors).toEqual([startingHostLine(statePath, hostLogPath(statePath))]);
    expect(lines.map(l => JSON.parse(l) as unknown)).toEqual([{ threads: [] }]);
  });

  it("the tool server starts one on its first call too", async () => {
    const here = servingStarter();
    const dial = dialer(statePath, { start: here.start, say: () => {} });
    const client = await dial();
    expect(here.calls).toEqual([statePath]);
    expect(await client.request("workspaces.list")).toMatchObject({ ok: true });
    await dial.close();
  });

  it("wsp with no word at all prints the help and serves nothing", async () => {
    const lines: string[] = [];
    expect(await cli(["--state", statePath], quietIO(lines), undefined, {}, false)).toBe(EXIT_CODES.ok);
    expect(lines.join("\n")).toContain("usage:");
    expect(existsSync(lockPathFor(statePath))).toBe(false);
  });

  it("a host started by a verb records it in its lock, and one a person started records nothing", async () => {
    vi.stubEnv(STARTED_BY_ENV, "verb");
    expect(startedByEnv(process.env)).toBe("verb");
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    handles.push(await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt }));
    expect((JSON.parse(readFileSync(lockPathFor(statePath), "utf8")) as HostLock).startedBy).toBe("verb");
    for (const h of handles.splice(0)) await h.close();
    await rt.close();

    vi.stubEnv(STARTED_BY_ENV, "");
    expect(startedByEnv(process.env)).toBeUndefined();
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    handles.push(await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt }));
    expect(JSON.parse(readFileSync(lockPathFor(statePath), "utf8")) as HostLock).not.toHaveProperty("startedBy");

    // The unit this computer's manager holds starts a host too, and its lock says which road that was, so wsp
    // down stops it and every other client knows whose host it met.
    for (const h of handles.splice(0)) await h.close();
    await rt.close();
    vi.stubEnv(STARTED_BY_ENV, "service");
    expect(startedByEnv(process.env)).toBe("service");
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    handles.push(await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt }));
    expect((JSON.parse(readFileSync(lockPathFor(statePath), "utf8")) as HostLock).startedBy).toBe("service");
  });

  it("starts nothing on a state file this computer's own manager is registered to serve, and says the one line that starts it", async () => {
    // The incident: the live host was down for a moment, and the first client that needed one started a host from
    // its own build on the state file the service owns, which rewrote records in that build's shape.
    const fake = fakeSpawn(() => {});
    const service = { unit: { name: "com.wsp.host.af639035", path: join(dir, "com.wsp.host.af639035.plist") }, words: "launchd agent" };
    const start = hostStarter({
      spawn: fake.spawn,
      wsp: { command: "wsp", args: [] },
      env: {},
      waitMs: 0,
      answers: () => Promise.resolve(false),
      registered: path => (path === statePath ? service : undefined),
    });
    const said: string[] = [];
    const refused = await start(statePath, line => said.push(line)).catch((e: unknown) => e);
    expect((refused as Error).message).toBe(`${statePath} is served by the launchd agent com.wsp.host.af639035, which is not running; wsp up --service --state ${statePath} starts it again`);
    expect(serviceServesStateLine(statePath, service)).toBe((refused as Error).message);
    // Nothing was spawned and nothing was said about starting one.
    expect(said).toEqual([]);
    expect(existsSync(hostLogPath(statePath))).toBe(false);

    // A state file no unit of this computer's names is started for as it always was.
    const other = join(dir, "other", "state.json");
    mkdirSync(join(dir, "other"), { recursive: true });
    const lock: HostLock = { pid: process.pid, port: 1, wsPort: 2, startedAt: new Date().toISOString() };
    const free = fakeSpawn(() => writeFileSync(lockPathFor(other), JSON.stringify(lock)));
    const starter = hostStarter({
      spawn: free.spawn,
      wsp: { command: "wsp", args: [] },
      env: {},
      waitMs: 2_000,
      answers: () => Promise.resolve(true),
      registered: path => (path === statePath ? service : undefined),
    });
    expect(await starter(other, () => {})).toEqual(lock);
  });
});
