// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeExec, nodeFs } from "../src/live-host.js";

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
  pids.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A job whose parent is gone is reaped by launchd, so it may read as alive for a moment after the kill. */
const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 100 && alive(pid); i += 1) await new Promise(r => setTimeout(r, 20));
  return !alive(pid);
};

const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "wsp-exec-"));
  dirs.push(d);
  return d;
};

/** Polls the pid file a shell writes so the pid is known before it is judged; a loaded machine starts a child late. */
const pidIn = async (file: string): Promise<number> => {
  for (let i = 0; i < 400 && !existsSync(file); i += 1) await new Promise(r => setTimeout(r, 20));
  const pid = Number(readFileSync(file, "utf8").trim());
  pids.push(pid);
  return pid;
};

describe("nodeFs.stat", () => {
  it("reads the modification time off the disk, so a reader can tell a file it already read has moved", async () => {
    const file = join(scratch(), "s1.jsonl");
    writeFileSync(file, "one\n");
    const before = await nodeFs.stat(file);
    expect(before).toMatchObject({ kind: "file", bytes: 4, mtimeMs: statSync(file).mtimeMs });
    utimesSync(file, new Date(), new Date(statSync(file).mtimeMs + 5_000));
    const after = await nodeFs.stat(file);
    expect(after!.mtimeMs).toBeGreaterThan(before!.mtimeMs);
  });
});

describe("nodeExec.run", () => {
  it("returns stdout on exit 0 and nothing on a failure or a missing command", async () => {
    expect(await nodeExec.run("/bin/sh", ["-c", "printf hi"])).toBe("hi");
    expect(await nodeExec.run("/bin/sh", ["-c", "echo out; exit 3"])).toBeUndefined();
    expect(await nodeExec.run("/nonexistent/wsp-bin", [])).toBeUndefined();
  });

  it("gives every child end of file on stdin, so a shell that reads it returns at once", async () => {
    expect(await nodeExec.run("/bin/sh", ["-c", "read x; echo done"], { timeoutMs: 5000 })).toBe("done\n");
  });

  it("adds the given variables to the collector's own environment", async () => {
    expect(await nodeExec.run("/bin/sh", ["-c", 'echo "$WSP_COLLECT:${PATH:+path}"'], { env: { WSP_COLLECT: "1" } })).toBe("1:path\n");
    expect(await nodeExec.run("/bin/sh", ["-c", 'echo "[$WSP_COLLECT]"'])).toBe("[]\n");
  });

  it("ends a child at the budget", async () => {
    const d = scratch();
    const out = nodeExec.run("/bin/sh", ["-c", `echo $$ > ${join(d, "pid")}; while :; do sleep 1; done`], { timeoutMs: 300 });
    const pid = await pidIn(join(d, "pid"));
    expect(alive(pid)).toBe(true);
    expect(await out).toBeUndefined();
    expect(await gone(pid)).toBe(true);
  }, 15_000);

  it("does not wait on a grandchild that kept stdout after the child exited, and ends it with the run", async () => {
    const d = scratch();
    const out = await nodeExec.run("/bin/sh", ["-c", `sleep 30 & echo $! > ${join(d, "pid")}; echo listed`]);
    const pid = await pidIn(join(d, "pid"));
    expect(out).toBe("listed\n");
    expect(await gone(pid)).toBe(true);
  }, 15_000);

  // The shell is a fixture here, not the subject: what this proves is that the budget takes the group, whatever
  // started the job in it. It is bash, which every Mac and every Linux runner has, read through --rcfile so the
  // person's own rc file is never sourced; macOS's bash 3.2 honours the flag for an interactive shell as well.
  it("the budget ends the whole process group: a job a real rc file started is dead when the run ends", async () => {
    const d = scratch();
    const rc = join(d, "rc");
    writeFileSync(rc, `sleep 100 & echo $! > ${join(d, "job")}; echo $$ > ${join(d, "pid")}; wait\n`);
    const out = nodeExec.run("/bin/bash", ["--rcfile", rc, "-ic", ":"], { timeoutMs: 500 });
    const shell = await pidIn(join(d, "pid"));
    const job = await pidIn(join(d, "job"));
    expect(alive(shell)).toBe(true);
    expect(alive(job)).toBe(true);
    expect(await out).toBeUndefined();
    expect(alive(shell)).toBe(false);
    expect(await gone(job)).toBe(true);
  }, 15_000);
});
