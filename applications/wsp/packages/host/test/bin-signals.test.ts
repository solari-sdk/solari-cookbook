// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BIN, DIST, describeWithBin } from "./built-bin.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";

interface Ports {
  port: number;
  wsPort: number;
}

function canListen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** Resolves once the bin has printed both address lines, so the host is bound. */
function untilServing(child: ChildProcess, output: string[]): Promise<Ports> {
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      output.push(chunk.toString());
      const port = text.match(/^app\s+http:\/\/127\.0\.0\.1:(\d+)$/m)?.[1];
      const wsPort = text.match(/^runtime ws\s+ws:\/\/127\.0\.0\.1:(\d+)/m)?.[1];
      if (port !== undefined && wsPort !== undefined) resolve({ port: Number(port), wsPort: Number(wsPort) });
    });
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.once("exit", (code, signal) => reject(new Error(`wsp exited early (code ${code}, signal ${signal}):\n${output.join("")}`)));
  });
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
}

describeWithBin("the wsp bin stops cleanly on a signal", () => {
  let home: string;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-bin-home-"));
  });
  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited(child);
    }
    child = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("%s removes host.lock and frees both ports", async signal => {
    const statePath = join(home, "state", "state.json");
    const lockPath = join(home, "state", "host.lock");
    mkdirSync(join(home, "state"));
    writeFileSync(statePath, JSON.stringify({ goldens: { default: SEALED_GOLDEN } }));
    const output: string[] = [];
    child = spawn(process.execPath, [BIN, "up", "--port", "0", "--ws-port", "0", "--state", statePath], {
      cwd: home,
      env: { ...process.env, SOLARI_API_KEY: "slr_live_fake_signal_key", HOME: home, WSP_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ports = await untilServing(child, output);
    expect(existsSync(lockPath)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${ports.port}/`)).status).toBe(200);

    child.kill(signal);
    const end = await exited(child);
    expect(end, output.join("")).toEqual({ code: 0, signal: null });
    expect(existsSync(lockPath)).toBe(false);
    expect(await canListen(ports.port)).toBe(true);
    expect(await canListen(ports.wsPort)).toBe(true);
  }, 30_000);

  it("serves a state file that holds nothing, records no workspace, and stops on the signal", async () => {
    // The command road a person types on a box with nothing on it: no golden, no workspace, no state file at all.
    const statePath = join(home, "state", "state.json");
    mkdirSync(join(home, "state"));
    const output: string[] = [];
    child = spawn(process.execPath, [BIN, "up", "--port", "0", "--ws-port", "0", "--state", statePath], {
      cwd: home,
      env: { ...process.env, SOLARI_API_KEY: "", ANTHROPIC_API_KEY: "", HOME: home, WSP_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ports = await untilServing(child, output);
    // A workspace is one project's copy, so a state with nothing in it records none and the line says the road.
    expect(output.join(""), output.join("")).toMatch(/^no projects yet; wsp add <folder> records one here/m);
    expect((await fetch(`http://127.0.0.1:${ports.port}/`)).status).toBe(200);
    const held = JSON.parse(readFileSync(statePath, "utf8")) as { workspaces?: Record<string, unknown> };
    expect(Object.values(held.workspaces ?? {})).toEqual([]);

    child.kill("SIGINT");
    expect(await exited(child), output.join("")).toEqual({ code: 0, signal: null });
  }, 30_000);
});

/** A host of this computer's own making: the wiring every `wsp up` wires, one turn running on it, and the signals
 * that stop it. The turn leads a process group of its own and reads its own log off this computer, so nothing the
 * host holds is what keeps it alive. */
const hostScript = (home: string, statePath: string, pidFile: string, runFile: string, gate: string): string => `
import { writeFileSync } from "node:fs";
import { localWiring, stopOnSignals } from ${JSON.stringify(DIST)};
const wiring = localWiring(${JSON.stringify(home)}, process.env, undefined, ${JSON.stringify(statePath)});
const stream = wiring.execStream()("echo $$ > ${pidFile}; echo first; while [ ! -f ${gate} ]; do sleep 0.05; done; echo second; sleep 300", { env: { PATH: process.env.PATH } });
writeFileSync(${JSON.stringify(runFile)}, stream.run + "\\n");
stopOnSignals({ close: () => wiring.close() }, { error: line => console.error(line) });
console.log("serving");
setInterval(() => {}, 60_000);
`;

/** The reader a host that comes next opens, in a process of its own: it never launched the run and re-opens it by
 * the handle the first host wrote down, which is what the runtime does for every row it finds running. */
const nextHostScript = (home: string, statePath: string, run: string): string => `
import { localWiring } from ${JSON.stringify(DIST)};
const wiring = localWiring(${JSON.stringify(home)}, process.env, undefined, ${JSON.stringify(statePath)});
const stream = await wiring.execStream().attach(${JSON.stringify(run)}, { input: false });
if (stream === "gone") { console.log("GONE"); process.exit(0); }
for await (const line of stream.lines) {
  console.log("LINE " + line);
  if (line === "second") break;
}
stream.kill();
await stream.exited;
process.exit(0);
`;

describeWithBin("a hangup on a host running a turn on this computer", () => {
  let home: string;
  let host: ChildProcess | undefined;
  let next: ChildProcess | undefined;
  /** The harness this turn stands for, so a red run leaves nothing of it on this Mac. */
  let harness: number | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-hangup-"));
  });
  afterEach(async () => {
    for (const child of [host, next]) {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited(child);
      }
    }
    host = undefined;
    next = undefined;
    if (harness !== undefined) {
      try {
        process.kill(-harness, "SIGKILL");
      } catch {
        harness = undefined;
      }
      harness = undefined;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("leaves the turn running and its reply lands in the host that comes next", async () => {
    const pidFile = join(home, "harness.pid");
    const runFile = join(home, "run");
    const gate = join(home, "gate");
    // The state file this host serves: its runs, its roots file and its inbox all sit in that file's own folder.
    const statePath = join(home, "state.json");
    const runDir = join(home, "runs");
    const script = join(home, "host.mjs");
    writeFileSync(script, hostScript(home, statePath, pidFile, runFile, gate));
    const output: string[] = [];
    // Its own process group, so the hangup this test delivers reaches the host and nothing else on this computer.
    host = spawn(process.execPath, [script], { cwd: home, stdio: ["ignore", "pipe", "pipe"], detached: true });
    host.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    host.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    await vi.waitFor(() => expect(output.join("")).toContain("serving"), { timeout: 10_000 });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
    harness = Number(readFileSync(pidFile, "utf8").trim());
    expect(harness).toBeGreaterThan(0);
    const run = readFileSync(runFile, "utf8").trim();
    expect(run.startsWith(runDir)).toBe(true);

    host.kill("SIGHUP");
    const end = await exited(host);
    expect(end, output.join("")).toEqual({ code: 0, signal: null });

    // The turn is still working with no host on this computer at all: this is the promise the wait sentence makes.
    expect(() => process.kill(harness!, 0), "the turn went with the host that started it").not.toThrow();

    // The host that comes next re-opens the run by its handle and reads the whole log, the line printed before it
    // existed and the one printed after.
    const nextScript = join(home, "next.mjs");
    writeFileSync(nextScript, nextHostScript(home, statePath, run));
    const read: string[] = [];
    next = spawn(process.execPath, [nextScript], { cwd: home, stdio: ["ignore", "pipe", "pipe"], detached: true });
    next.stdout?.on("data", (chunk: Buffer) => read.push(chunk.toString()));
    next.stderr?.on("data", (chunk: Buffer) => read.push(chunk.toString()));
    await vi.waitFor(() => expect(read.join("")).toContain("LINE first"), { timeout: 15_000 });
    writeFileSync(gate, "go\n");
    await vi.waitFor(() => expect(read.join("")).toContain("LINE second"), { timeout: 15_000 });
    await exited(next);
  }, 60_000);
});
