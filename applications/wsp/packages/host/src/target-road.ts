// SPDX-License-Identifier: AGPL-3.0-only
// Where a write on one computer or workspace runs: this computer's own bash,
// a joined computer's exec with its bytes on stdin, or a workspace's machine
// with its bytes staged first; every line as that computer's login (asLogin),
// and the reader's Host over the same road, so an act finds what the report
// shows.
import { spawn } from "node:child_process";
import type { Host } from "@wsp/collect";
import { asLogin, stageAsLogin, targetLogin, type ExecResult } from "@wsp/engine";
import { shellQuote } from "@wsp/protocol";
import type { AgentsOn } from "@wsp/runtime";
import { machineHost } from "./machine-host.js";

export const WRITE_MS = 60_000;

/** Where a target's lines run: the reader's Host over it, and one line as its login with bytes on its stdin. */
export interface Road {
  host: Host;
  run(line: string, stdin?: Uint8Array): Promise<ExecResult>;
}

/** A line in this computer's own bash, with the home the Host reads; past its time the line and all it started die. */
export function runHere(home: string, line: string, stdin?: Uint8Array, ms = WRITE_MS): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = spawn("/bin/bash", ["-c", line], { env: { ...process.env, HOME: home }, cwd: home, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, ms);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.stdin.on("error", () => undefined);
    child.on("error", e => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout: "", stderr: e.message });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.end(stdin === undefined ? undefined : Buffer.from(stdin));
  });
}

export async function roadOf(on: AgentsOn, here: () => Host, what: string): Promise<Road> {
  if (on.kind === "here") {
    const host = here();
    return { host, run: (line, stdin) => runHere(host.home, line, stdin) };
  }
  const login = await targetLogin(on.machine, on.kind === "box" ? on.login : {});
  const bound = { timeoutMs: WRITE_MS };
  if (on.kind === "box") {
    const machine = on.machine;
    return { host: machineHost(machine, login, { stdin: true }), run: (line, stdin) => machine.exec(asLogin(login, line), { ...bound, ...(stdin !== undefined ? { stdin } : {}) }) };
  }
  const machine = on.machine;
  return {
    host: machineHost(machine, login, { land: machine }),
    run: (line, stdin) => (stdin === undefined ? machine.exec(asLogin(login, line), bound) : stageAsLogin(machine, machine, login, what, stdin, file => machine.exec(asLogin(login, `{\n${line}\n} < ${shellQuote(file)}`), bound), bound)),
  };
}

export const firstLine = (r: ExecResult): string => (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.exitCode}`;
