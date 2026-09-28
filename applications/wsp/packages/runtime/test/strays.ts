// SPDX-License-Identifier: AGPL-3.0-only
// What a local turn leaves running while a test reads it, and how a test reads
// whether it is still there. Every pid here is one the command under test
// wrote to a file of its own, never a pid found by name or port, and the sweep
// runs after each test so a red run leaves nothing burning a core on this
// computer.
import { readFileSync } from "node:fs";
import { expect, vi } from "vitest";

const strays: number[] = [];

/** The pid a command wrote to `file`, once the file holds one: the shell creates it before it writes, so an empty
 * file is not yet an answer. Recorded for the sweep. */
export async function grandchild(file: string): Promise<number> {
  await vi.waitFor(() => expect(readFileSync(file, "utf8").trim()).not.toBe(""), { timeout: 5_000 });
  const pid = Number(readFileSync(file, "utf8").trim());
  expect(pid).toBeGreaterThan(0);
  strays.push(pid);
  return pid;
}

/** Whether that pid is still there; signal 0 asks the kernel and sends nothing. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until the pid is gone: a kill is delivered before the kernel clears the entry it was sent to. */
export function gone(pid: number): Promise<void> {
  return vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
}

export function sweepStrays(): void {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
}
