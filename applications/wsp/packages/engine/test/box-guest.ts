// SPDX-License-Identifier: AGPL-3.0-only
// A computer somebody owns, as a temp directory: every exec and every run is
// this machine's own bash over that directory, the byte road writes the file,
// and the PATH checks, the uv install and the df reading are canned. The
// files it ends with are what a test reads. sha256sum rides on the PATH as a
// script of node's, so one script runs the same on a Mac and on Linux.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FREE_KB_CMD } from "../src/golden-tools.js";
import type { ExecResult, Machine } from "../src/machine.js";
import { sha256sumBin } from "./sha256sum-bin.js";

const FREE_KB = String(3000 * 1024);

export interface BoxGuest {
  /** The computer's home directory on this machine. */
  root: string;
  cmds: string[];
  runs: string[];
  runOpts: { unlogged?: boolean }[];
  landed: string[];
  machine: Machine;
  /** Everything the guest made, removed by the caller's cleanup. */
  dirs: string[];
}

export function boxGuest(present: string[] = [], canned: Record<string, ExecResult> = {}): BoxGuest {
  const root = mkdtempSync(join(tmpdir(), "wsp-box-guest-"));
  const bin = sha256sumBin();
  const cmds: string[] = [];
  const runs: string[] = [];
  /** The command through a real bash, with whatever bytes the caller had for its stdin and its stdin closed after
   * them, which is what the daemon does with the field its exec frame carries. */
  const bash = (cmd: string, stdin?: Uint8Array): Promise<ExecResult> =>
    new Promise(resolve => {
      const child = spawn("bash", ["-c", cmd], { env: { ...process.env, PATH: `${bin}:${join(process.execPath, "..")}:${process.env.PATH ?? ""}` } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("close", code => resolve({ exitCode: code ?? 1, stdout, stderr }));
      child.stdin.end(stdin === undefined ? undefined : Buffer.from(stdin));
    });
  const exec = async (cmd: string, opts?: { stdin?: Uint8Array }): Promise<ExecResult> => {
    cmds.push(cmd);
    if (cmd.includes("astral-sh/uv/releases")) return canned.uv ?? { exitCode: 0, stdout: "", stderr: "" };
    if (cmd === FREE_KB_CMD) return { exitCode: 0, stdout: `${FREE_KB}\n`, stderr: "" };
    if (cmd.includes("command -v")) {
      const asked = [...cmd.matchAll(/command -v '([^']*)'/g)].map(m => m[1]!);
      return { exitCode: 0, stdout: asked.map(c => `${present.includes(c) ? "ok" : "no"} ${c}`).join("\n"), stderr: "" };
    }
    return bash(cmd, opts?.stdin);
  };
  const landed: string[] = [];
  const runOpts: { unlogged?: boolean }[] = [];
  const machine = {
    id: "spoo",
    kind: "sandbox",
    exec,
    run: (script: string, o: { unlogged?: boolean }) => {
      runs.push(script);
      runOpts.push(o);
      return exec(script);
    },
    // The backend road for bytes, as a box's daemon carries it; what follows it is the guest's own.
    putBytes: async (path: string, bytes: Uint8Array) => {
      landed.push(path);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, bytes);
    },
  } as unknown as Machine;
  return { root, cmds, runs, runOpts, landed, machine, dirs: [root, bin] };
}

export const cleanGuests = (guests: readonly BoxGuest[]): void => {
  for (const g of guests) for (const d of g.dirs) rmSync(d, { recursive: true, force: true });
};
