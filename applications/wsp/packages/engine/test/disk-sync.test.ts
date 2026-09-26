// SPDX-License-Identifier: AGPL-3.0-only
// The guest's sync before a copy: one command, the counters read once after
// it, a failed sync typed, and a refusal the exec threw kept as itself.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diskSyncFailedLine } from "@wsp/protocol";
import { DISK_SYNC_CMD, DiskSyncError, diskUnsettled, syncDisk } from "../src/disk-sync.js";
import { INLINE_EXEC_MS, machineAnswer } from "../src/exec-detached.js";
import type { ExecResult, Machine } from "../src/machine.js";

/** A guest whose every exec answers `answer`, recording each command with its bound. */
function guest(answer: () => ExecResult) {
  const execs: { cmd: string; timeoutMs: number | undefined }[] = [];
  const machine = {
    id: "m1",
    exec: async (cmd: string, o?: { timeoutMs?: number }) => {
      execs.push({ cmd, timeoutMs: o?.timeoutMs });
      return answer();
    },
  } as unknown as Machine;
  return { machine, execs };
}

const printed = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

describe("syncDisk", () => {
  it("runs the one sync command under the inline bound and answers both counters at zero as settled", async () => {
    const { machine, execs } = guest(() => printed("Dirty: 0\nWriteback: 0\n"));
    const read = await syncDisk(machine);
    expect(read).toEqual({ dirtyKb: 0, writebackKb: 0 });
    expect(diskUnsettled(read)).toBe(false);
    expect(execs).toEqual([{ cmd: DISK_SYNC_CMD, timeoutMs: INLINE_EXEC_MS }]);
  });

  it("answers what a writer still running left, once, and never waits for it to stop", async () => {
    const { machine, execs } = guest(() => printed("Dirty: 12288\nWriteback: 64\n"));
    const read = await syncDisk(machine);
    expect(read).toEqual({ dirtyKb: 12288, writebackKb: 64 });
    expect(diskUnsettled(read)).toBe(true);
    expect(execs).toHaveLength(1);
  });

  it("a sync that exits non-zero throws the typed failure with the machine's answer in the sentence", async () => {
    const res = { exitCode: 1, stdout: "", stderr: "sync: error syncing '/': Input/output error" };
    const { machine } = guest(() => res);
    const err = await syncDisk(machine).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiskSyncError);
    expect((err as Error).message).toBe(diskSyncFailedLine(machineAnswer(res)));
    expect((err as Error).message).toBe("the disk could not be synced (it exited 1 and said: sync: error syncing '/': Input/output error); nothing was snapshotted");
  });

  it("a guest that synced and printed no counters has synced: no reading, nothing unsettled", async () => {
    const { machine } = guest(() => printed(""));
    const read = await syncDisk(machine);
    expect(read).toBeUndefined();
    expect(diskUnsettled(read)).toBe(false);
  });

  it("an exec the provider refused passes as that refusal, kind and status intact", async () => {
    const gone = Object.assign(new Error("Sandbox not found"), { kind: "missing", status: 404 });
    const machine = { id: "m1", exec: async () => { throw gone; } } as unknown as Machine;
    await expect(syncDisk(machine)).rejects.toBe(gone);
  });

  it.skipIf(!existsSync("/proc/meminfo"))("the command runs on this Linux machine's bash and prints both counters in the shape the reader parses", async () => {
    const stdout = execFileSync("bash", ["-c", DISK_SYNC_CMD], { encoding: "utf8" });
    const machine = { id: "here", exec: async () => printed(stdout) } as unknown as Machine;
    const read = await syncDisk(machine);
    expect(read).toEqual({ dirtyKb: expect.any(Number), writebackKb: expect.any(Number) });
  });
});
