// SPDX-License-Identifier: AGPL-3.0-only
// The guard runs for real here, under this machine's bash: setsid is a shim on PATH
// (perl's setpgrp gives the job its own process group, which is what the kill
// needs), and /proc is absent, so the descendant walk finds nothing and the
// group kill alone has to end the tool and its children.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { guarded } from "../src/golden-tools.js";

const run = promisify(execFile);
/** Seconds a timed-out tool gets to reach its markers: the guard checks once a second from launch, and under load the sh, perl and bash chain took over a second to start. */
const STARTUP_S = 5;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function shimDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-guard-"));
  dirs.push(dir);
  if (!existsSync("/proc/1/stat")) {
    writeFileSync(join(dir, "setsid"), "#!/bin/sh\nexec perl -e 'setpgrp(0, 0); exec @ARGV or die $!' -- \"$@\"\n");
    chmodSync(join(dir, "setsid"), 0o755);
  }
  return dir;
}

async function bash(script: string, dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run("bash", ["-c", script], { env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}` }, timeout: 60_000 });
    return { code: 0, ...r };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("guarded", () => {
  it("a script that ends in time returns its own exit code and output", async () => {
    const dir = shimDir();
    const r = await bash(guarded("echo out; echo err >&2; exit 3", 5), dir);
    expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("a script that outlives its timeout is ended by the TERM with its children, the output so far is kept, and the exit is 124", async () => {
    const dir = shimDir();
    const pids = join(dir, "pids");
    const signal = join(dir, "signal");
    // The tool records itself and a child it waits on, as brew waits on curl or tar, and says which signal ended it.
    const tool = `trap 'echo term > ${signal}; exit 143' TERM; echo "$$" > ${pids}; sleep 30 & echo "$!" >> ${pids}; echo started; wait`;
    const r = await bash(guarded(tool, STARTUP_S), dir);
    expect(r.code).toBe(124);
    expect(r.stdout).toBe("started\n");
    expect(r.stderr).toBe("");
    // The TERM was enough: the trap ran, so the KILL never had to.
    expect(readFileSync(signal, "utf8")).toBe("term\n");
    const [self, child] = readFileSync(pids, "utf8").trim().split("\n").map(Number);
    expect(alive(self!)).toBe(false);
    expect(alive(child!)).toBe(false);
  }, 30_000);

  it("a child that ignores TERM meets the KILL, and the guard still returns only once it is gone", async () => {
    const dir = shimDir();
    const pids = join(dir, "pids");
    const tool = `trap '' TERM; echo "$$" > ${pids}; sleep 30 & echo "$!" >> ${pids}; wait`;
    const r = await bash(guarded(tool, STARTUP_S), dir);
    expect(r.code).toBe(124);
    const [self, child] = readFileSync(pids, "utf8").trim().split("\n").map(Number);
    expect(alive(self!)).toBe(false);
    expect(alive(child!)).toBe(false);
  }, 60_000);
});
