// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, hostRoadWord, hostStoppedLine, serve, type CliIO } from "../src/cli.js";
import { ownPid, pidAlive } from "../src/host-lock.js";
import type { HostHandle } from "../src/server.js";
import { stubBackend } from "./stub-backend.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

const PAGE = `<!doctype html>
<html><head><script type="module" crossorigin src="/assets/app.js"></script></head>
<body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>
</body></html>
`;

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const quietIO: CliIO = { log: () => {}, error: () => {}, ask: noPrompt, askSecret: noPrompt };

function testRuntime(): Runtime {
  return createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
}

interface Lock {
  pid: number;
  port: number;
  wsPort: number;
  startedAt: string;
  startedBy?: "verb";
}

function readLock(path: string): Lock {
  return JSON.parse(readFileSync(path, "utf8")) as Lock;
}

/** A pid that was real a moment ago and is not alive now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid;
}

describe("serve takes host.lock next to the state file", () => {
  let dir: string;
  let home: string;
  let webDir: string;
  let statePath: string;
  let lockPath: string;
  const handles: HostHandle[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-lock-home-"));
    home = join(dir, "custom");
    webDir = join(home, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(home, "state", "state.json");
    lockPath = join(home, "state", "host.lock");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_lock_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", home);
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(dir: string = webDir): Promise<HostHandle> {
    const h = await serve(quietIO, { port: 0, wsPort: 0, statePath, webDir: dir, runtime: testRuntime() });
    handles.push(h);
    return h;
  }

  it("writes pid, ports and start time, and removes the lock on close", async () => {
    const before = Date.now();
    const h = await start();
    const lock = readLock(lockPath);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(h.port);
    expect(lock.wsPort).toBe(h.wsPort);
    expect(Date.parse(lock.startedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(lock.startedAt)).toBeLessThanOrEqual(Date.now());

    await h.close();
    handles.splice(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("the state folder is the owner's when the host takes its lock, and one an older build left wider is repaired", async () => {
    mkdirSync(join(home, "state"), { recursive: true });
    chmodSync(join(home, "state"), 0o755);
    const h = await start();
    expect(statSync(join(home, "state")).mode & 0o777).toBe(0o700);
    expect(existsSync(lockPath)).toBe(true);
    await h.close();
    handles.splice(0);
  });

  it("refuses a second host on the same state file, naming the running pid and ports", async () => {
    const first = await start();
    await expect(start()).rejects.toThrow(
      new RegExp(`pid ${process.pid}\\b.*\\b${first.port}\\b.*\\b${first.wsPort}\\b`),
    );
    // The loser must not take the winner's lock with it.
    expect(readLock(lockPath).port).toBe(first.port);
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200);
  });

  it("names wsp down when the lock a second host meets was written by a host a verb started", async () => {
    const first = await start();
    writeFileSync(lockPath, JSON.stringify({ ...readLock(lockPath), startedBy: "verb" }));
    await expect(start()).rejects.toThrow("wsp down stops it, or point --state at a different file.");
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200);
  });

  it("names wsp down for the service's own host too, since wsp down is what stops that one", async () => {
    const first = await start();
    writeFileSync(lockPath, JSON.stringify({ ...readLock(lockPath), startedBy: "service" }));
    await expect(start()).rejects.toThrow("wsp down stops it, or point --state at a different file.");
    expect(hostRoadWord("service")).toBe("the service");
    expect(hostStoppedLine("service", 42, lockPath)).toBe(`stopped the host the service started (pid 42); nothing serves ${lockPath} now`);
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200);
  });

  it("removes a lock whose pid is no longer alive and starts", async () => {
    mkdirSync(join(home, "state"));
    const stale = { pid: deadPid(), port: 1, wsPort: 2, startedAt: "2026-09-01T00:00:00.000Z" };
    writeFileSync(lockPath, JSON.stringify(stale));

    const h = await start();
    const lock = readLock(lockPath);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(h.port);
  });

  it("writes nothing under the person's own wsp home while it serves a home somebody named", async () => {
    // A host on another state file writing a file under ~/.wsp is two hosts sharing one file; the one way a line
    // reaches this host is naming its home, which the person does with --state or WSP_HOME.
    const h = await start();
    expect(existsSync(join(dir, "user", ".wsp"))).toBe(false);

    await h.close();
    handles.splice(0);
    expect(existsSync(join(dir, "user", ".wsp"))).toBe(false);
  });

  it("wsp init refuses when the host holding the lock cannot take the build, naming wsp down before any pid, and boots nothing", async () => {
    // A lock a live process holds whose host answers nowhere: the build cannot go through its door, so the run says
    // how to take that host down. A host that does answer takes the build instead; that road is init-beside's test.
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port: 1, wsPort: 1, address: "127.0.0.1", startedAt: new Date().toISOString() }));
    writeFileSync(join(home, "state", "host-token"), "tok");
    // A host somewhere else is where every other verb would go; the build belongs to the process holding this lock.
    vi.stubEnv("WSP_HOST", "elsewhere");
    const errors: string[] = [];
    const code = await cli(["init", "--state", statePath], { ...quietIO, error: line => errors.push(line) });
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`wsp init: the wsp host serving ${statePath} (pid ${process.pid}) cannot take this build`);
    expect(errors[0]).toContain(`Take it down first (wsp down for a service, Ctrl-C in its terminal or kill ${process.pid} for one started by hand)`);
    expect(errors[0]).not.toContain("elsewhere");
    expect(readLock(lockPath).pid).toBe(process.pid);
  });

  it("wsp init --provider beside a serving host is refused, naming the provider that host forks on and the wsp up that moves it", async () => {
    // The host serving this state file is the process that runs the build, on the provider it started on: a
    // provider named on this line reaches no runtime of this run's, so it is said out loud rather than dropped.
    vi.stubEnv("WSP_PROVIDER", "solari");
    const first = await start();
    const errors: string[] = [];
    const code = await cli(["init", "--provider", "box", "--state", statePath], { ...quietIO, error: line => errors.push(line) });
    expect(code).toBe(3);
    // The wsp up the sentence hands over is this run's own line, so it names the state file this home keeps its
    // host under: without the --state it would start a host on this computer's default state file instead.
    expect(errors).toEqual([
      `wsp init: the wsp host serving ${statePath} (pid ${process.pid}) runs this build and forks on solari, not box. Drop --provider, or take that host down and start it again with wsp up --state '${statePath}' --provider 'box'.`,
    ]);
    // Refused before the run opens: the host is still serving and nothing of the build was read or booted.
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200);
  });

  it("does not leave a lock behind when the host fails to start", async () => {
    const broken = join(home, "broken-web");
    mkdirSync(broken);
    await expect(start(broken)).rejects.toThrow(/web app not built/);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("what the lock's pid says", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-lock-reads-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** A pid that was real a moment ago and is not alive now. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", "0"]);
    expect(child.status).toBe(0);
    return child.pid;
  }

  it("reads a pid of this login as its own, and a pid that is gone as neither own nor alive", () => {
    expect(ownPid(process.pid)).toBe(true);
    expect(pidAlive(process.pid)).toBe(true);
    const gone = deadPid();
    expect(ownPid(gone)).toBe(false);
    expect(pidAlive(gone)).toBe(false);
  });

  it.runIf(process.getuid !== undefined && process.getuid() !== 0)("reads a live process of another login as not this login's, while it is still a held lock", () => {
    // Process 1 belongs to root and answers EPERM to a signal from anyone else, which is the one reading here.
    expect(ownPid(1)).toBe(false);
    expect(pidAlive(1)).toBe(true);
  });
});
