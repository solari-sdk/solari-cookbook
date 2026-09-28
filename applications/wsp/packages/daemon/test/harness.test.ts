// SPDX-License-Identifier: AGPL-3.0-only
// The harness itself, against binaries that are not daemons: what it says when
// one dies before it listens, and that one which binds and never speaks is
// killed rather than left holding its port after the harness gives up on it.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnDaemon } from "./harness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A binary written for one case. Run once first, doing nothing: the first exec of a fresh script pays the system's
 * scan of it, near half a second here, and a bound shorter than that would kill the script before its first line. */
function fakeBin(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-fake-bin-"));
  dirs.push(dir);
  const bin = join(dir, "not-a-daemon");
  writeFileSync(bin, `#!/bin/sh\n[ -n "$WSP_FAKE_BIN_WARM" ] && exit 0\n${body}\n`);
  chmodSync(bin, 0o755);
  execFileSync(bin, { env: { ...process.env, WSP_FAKE_BIN_WARM: "1" } });
  return bin;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the harness around a binary that is not a daemon", () => {
  it("fails at once with the exit code and the stderr when the binary dies before it listens", async () => {
    const bin = fakeBin('echo "no token file" >&2\nexit 3');
    await expect(spawnDaemon(bin, { port: 0 })).rejects.toThrow(/exited with 3 before it listened:\nno token file/);
  });

  it("kills a binary that never prints its listening line, so nothing a test started outlives it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-fake-bin-pid-"));
    dirs.push(dir);
    const pidFile = join(dir, "pid");
    // Says something, never the line, and would run for a minute: the harness gives up and takes it down.
    const bin = fakeBin(`echo $$ > '${pidFile}'\necho "still starting" >&2\nsleep 60`);
    await expect(spawnDaemon(bin, { port: 0 }, { startMs: 1_000, stopMs: 1_000 })).rejects.toThrow(/did not print its listening line within 1000 ms:\nstill starting/);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
  });
});
