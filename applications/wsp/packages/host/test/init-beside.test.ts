// SPDX-License-Identifier: AGPL-3.0-only
// wsp init's hand-off to a host already serving the state, over that host's
// real socket: the ops the door sees, the rows the terminal prints as they
// land, the code a sign-in's page asks for, and the exit code each ending
// leaves. The door here is a scripted one, so the build's own work is the init
// job's test; what this proves is the road between the two.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { CLOUD_SETUP_WORDS, INIT_ROW_STATES, initSignInOutcome, SIGN_IN_OPEN_STATE, type InitJob, type InitJobEvent, type InitRow, type InitSetup } from "@wsp/protocol";
import { createRuntime, memoryStore, type InitDoor } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { buildBesideHost } from "../src/init-beside.js";
import { hostTokenPath, lockPathFor } from "../src/host-lock.js";
import type { InitIO } from "../src/init.js";
import { startHost, type HostHandle } from "../src/server.js";
import { dialHost } from "../src/verbs.js";
import { stubBackend } from "./stub-backend.js";
import { PAGE } from "./verbs-fixture.js";

const JOB = {
  id: "init_1",
  road: "terminal",
  keys: { solari: true },
  step: 0,
  stoppable: true,
  screens: [],
  progress: { done: 0, total: 1 },
  log: [],
} satisfies Partial<InitJob>;

/** A door the test drives by hand: every op is recorded, and the views it pushes are what the terminal draws. */
class ScriptedDoor implements InitDoor {
  readonly calls: { op: string; args?: unknown }[] = [];
  private readonly listeners = new Set<(e: InitJobEvent) => void>();
  job: InitJob = { ...JOB, phase: "reading", rows: [] };

  push(over: Partial<InitJob>): void {
    this.job = { ...this.job, ...over };
    for (const fn of this.listeners) fn({ type: "init.job", job: this.job });
  }

  async get(): Promise<InitSetup> {
    return { keys: { solari: true }, home: "/home/maya", agents: [], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.1 }, job: this.job };
  }
  async start(o: { road: string }): Promise<InitJob> {
    this.calls.push({ op: "start", args: o });
    return this.job;
  }
  async build(o: unknown): Promise<InitJob> {
    this.calls.push({ op: "build", args: o });
    return this.job;
  }
  async signInCode(o: { tool: string; code: string }): Promise<InitJob> {
    this.calls.push({ op: "signInCode", args: o });
    return this.job;
  }
  async cancel(): Promise<InitJob> {
    this.calls.push({ op: "cancel" });
    this.push({ phase: "cancelled", error: "You stopped the build" });
    return this.job;
  }
  async keys(): Promise<InitSetup> {
    return this.get();
  }
  async answer(): Promise<InitJob> {
    return this.job;
  }
  async step(): Promise<InitJob> {
    return this.job;
  }
  async draft(): Promise<InitJob> {
    return this.job;
  }
  async retry(): Promise<InitJob> {
    return this.job;
  }
  on(fn: (e: InitJobEvent) => void): () => void {
    this.listeners.add(fn as (e: InitJobEvent) => void);
    return () => this.listeners.delete(fn as (e: InitJobEvent) => void);
  }
}

const stage = (id: string, label: string, state: string, over: Partial<InitRow> = {}): InitRow => ({ id, kind: "stage", label, state, ...over });

const dirs: string[] = [];
const handles: HostHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Beside {
  door: ScriptedDoor;
  io: InitIO;
  signals: EventEmitter;
  text(): string;
  statePath: string;
  handle: HostHandle;
  /** Where the app that host serves answers, as the run is told it. */
  app: { at: { port: number; address: string }; runDir: string; interactive: boolean };
}

/** Spends a code the way the page wsp init opens does: the first frame of a socket nothing authed. */
async function redeem(port: number, code: string): Promise<{ deviceId?: string; deviceToken?: string; error?: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  const reply = await new Promise<Record<string, unknown>>(done => {
    ws.once("message", raw => done(JSON.parse(String(raw)) as Record<string, unknown>));
    ws.send(JSON.stringify({ id: 1, op: "pair.redeem", code, name: "a Mac in a browser" }));
  });
  ws.close();
  return reply as { deviceId?: string; deviceToken?: string; error?: string };
}

/** A real host over the scripted door, its lock and token written where a host writes them, so the run dials it the
 * way wsp init does. */
async function serving(): Promise<Beside> {
  const dir = mkdtempSync(join(tmpdir(), "wsp-beside-"));
  dirs.push(dir);
  const webDir = join(dir, "web");
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
  writeFileSync(join(webDir, "index.html"), PAGE);
  const statePath = join(dir, "state", "state.json");
  mkdirSync(join(dir, "state"), { recursive: true });
  const door = new ScriptedDoor();
  const handle = await startHost({
    runtime: createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} }),
    webDir,
    port: 0,
    wsPort: 0,
    statePath,
    init: door,
  });
  handles.push(handle);
  writeFileSync(lockPathFor(statePath), JSON.stringify({ pid: process.pid, port: handle.port, wsPort: handle.wsPort, address: "127.0.0.1", startedAt: new Date().toISOString() }));
  writeFileSync(hostTokenPath(statePath), handle.authToken, { mode: 0o600 });
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const signals = new EventEmitter();
  const io: InitIO = {
    input: new PassThrough(),
    output,
    stderr: output,
    // A person at the keyboard: the code a sign-in's page hands back is typed here.
    isTTY: true,
    env: {},
    open: async () => false,
    signals,
    exit: () => {},
  };
  return { door, io, signals, text: () => stripVTControlCharacters(chunks.join("")), statePath, handle, app: { at: { port: handle.port, address: "127.0.0.1" }, runDir: join(dir, "state", "runs"), interactive: false } };
}

describe("the build wsp init hands to the host serving the state", () => {
  it("starts the terminal road, asks for the build, prints every row as it lands and ends on the golden that host recorded", async () => {
    const f = await serving();
    const client = await dialHost(f.statePath);
    const run = buildBesideHost({ client, io: f.io, fork: { name: "beside", folder: "/Users/maya/spoo" }, yes: true, on: "spoo", app: f.app });
    await until(() => f.door.calls.some(c => c.op === "start"));
    expect(f.door.calls[0]).toEqual({ op: "start", args: { road: "terminal" } });
    f.door.push({ phase: "answering" });
    await until(() => f.door.calls.some(c => c.op === "build"));
    expect(f.door.calls[1]).toEqual({ op: "build", args: { firstWorkspace: "beside", importFolder: "/Users/maya/spoo", yes: true, on: "spoo" } });

    f.door.push({ phase: "building", rows: [stage("stage/creating", "Machine created", INIT_ROW_STATES.running)] });
    f.door.push({ phase: "building", rows: [stage("stage/creating", "Machine created", INIT_ROW_STATES.slot)] });
    f.door.push({ phase: "building", rows: [stage("stage/creating", "Machine created", INIT_ROW_STATES.done, { detail: "sandbox from ubuntu:24.04", ms: 332 })] });
    f.door.push({
      phase: "done",
      golden: { version: 1 },
      workspace: { id: "ws_1", name: "beside" },
      rows: [
        stage("stage/creating", "Machine created", INIT_ROW_STATES.done, { detail: "sandbox from ubuntu:24.04", ms: 332 }),
        stage("stage/installing-tools", "Tools installed", INIT_ROW_STATES.skipped),
        { id: "workspace/beside", kind: "workspace", label: "beside", state: INIT_ROW_STATES.forked },
      ],
    });
    expect(await run).toBe(0);
    const out = f.text();
    // The row's own words, its detail and how long it took, once, as it settled.
    expect(out).toContain("Machine created");
    expect(out).toContain("sandbox from ubuntu:24.04");
    // Twice: once when the account had no room for it, once when it landed. A wait nobody says reads as a hang.
    expect(out).toContain(`Machine created: ${INIT_ROW_STATES.slot}`);
    expect(out.match(/Machine created/g)).toHaveLength(2);
    // A row that ended with nothing run says so rather than wearing the same glyph as work that happened.
    expect(out).toContain(`Tools installed  ${INIT_ROW_STATES.skipped}`);
    expect(out).toContain("Image v1 sealed on the host serving this state.");
    expect(out).toContain("Workspace beside (ws_1) forked from it.");
    // The app opens on the workspace the build forked, at an address carrying a code that host minted over this
    // run's own socket: the browser it lets in is the owner's, listed as such and revocable like any other.
    const opened = /Open (http:\/\/127\.0\.0\.1:\d+\/#w\/ws_1\/c\/([0-9A-Z]{8}))/.exec(out);
    expect(opened, out).not.toBeNull();
    expect(opened![1]).toBe(`http://127.0.0.1:${f.handle.port}/#w/ws_1/c/${opened![2]!}`);
    const admitted = await redeem(f.handle.wsPort, opened![2]!);
    expect(typeof admitted.deviceToken).toBe("string");
    const { devices } = await client.request<{ devices: { id: string; here?: true }[] }>("devices.list");
    expect(devices).toEqual([{ id: admitted.deviceId, here: true, name: "a Mac in a browser", createdAt: expect.any(String), lastSeenAt: expect.any(String) }]);
    client.close();
  });

  it("off a terminal the page is handed over and no code is asked for, since nobody is at that stdin", async () => {
    const f = await serving();
    Object.assign(f.io, { isTTY: false });
    const client = await dialHost(f.statePath);
    const run = buildBesideHost({ client, io: f.io });
    await until(() => f.door.calls.some(c => c.op === "start"));
    f.door.push({ phase: "answering" });
    await until(() => f.door.calls.some(c => c.op === "build"));
    f.door.push({ phase: "signing-in", rows: [{ id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", finish: "code" }] });
    await until(() => f.text().includes("https://github.com/login/device"));
    f.door.push({ phase: "failed", error: "the machine went away" });
    expect(await run).toBe(1);
    expect(f.door.calls.map(c => c.op)).not.toContain("signInCode");
    expect(f.text()).not.toContain(CLOUD_SETUP_WORDS.build.codeAsk);
    expect(f.text()).toContain("The build stopped: the machine went away");
    client.close();
  });

  it("ends the code prompt with the row it belongs to, so a build that sealed without one leaves no prompt holding the terminal", async () => {
    const f = await serving();
    const client = await dialHost(f.statePath);
    const run = buildBesideHost({ client, io: f.io });
    await until(() => f.door.calls.some(c => c.op === "start"));
    f.door.push({ phase: "answering" });
    await until(() => f.door.calls.some(c => c.op === "build"));
    f.door.push({ phase: "signing-in", rows: [{ id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", finish: "code" }] });
    await until(() => f.text().includes(CLOUD_SETUP_WORDS.build.codeAsk));
    // Nobody types it: the sign-in runs out, the build seals, and the run has to end rather than sit on that prompt.
    f.door.push({ phase: "done", golden: { version: 1 }, rows: [{ id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", ...initSignInOutcome("not-signed-in", "darwin") }] });
    expect(await run).toBe(0);
    expect(f.door.calls.map(c => c.op)).not.toContain("signInCode");
    expect(f.text()).toContain("Image v1 sealed on the host serving this state.");
    // Nothing of that prompt is left on stdin: a live one holds the terminal in raw mode and this process with it.
    expect((f.io.input as PassThrough).listenerCount("keypress")).toBe(0);
    client.close();
  });

  it("hands the sign-in's page over and types the code that page asked for back into the machine; a stop from the terminal cancels the job", async () => {
    const f = await serving();
    const client = await dialHost(f.statePath);
    const input = f.io.input as PassThrough;
    const run = buildBesideHost({ client, io: f.io, app: f.app });
    await until(() => f.door.calls.some(c => c.op === "start"));
    f.door.push({ phase: "answering" });
    await until(() => f.door.calls.some(c => c.op === "build"));
    expect(f.door.calls[1]).toEqual({ op: "build", args: {} });

    f.door.push({ phase: "signing-in", rows: [{ id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", finish: "code" }] });
    await until(() => f.text().includes("https://github.com/login/device"));
    input.write("ABCD-1234\r");
    await until(() => f.door.calls.some(c => c.op === "signInCode"));
    expect(f.door.calls.at(-1)).toEqual({ op: "signInCode", args: { tool: "gh", code: "ABCD-1234" } });

    f.signals.emit("SIGINT");
    expect(await run).toBe(1);
    expect(f.door.calls.map(c => c.op)).toContain("cancel");
    expect(f.text()).toContain("You stopped the build");
    client.close();
  });
});

async function until(holds: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (holds()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("never happened");
}
