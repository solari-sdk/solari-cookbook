// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync, type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Fed<T> = Omit<T, "input" | "stdio">;

/** spawnSync with `stdin` read from an unlinked file, never spawnSync's `input`: on macOS that pipe can hand over a
 * few hundred kilobytes and never their end, so the child waits on EOF until killed (node 22, a few calls in ten
 * thousand at a megabyte on a loaded Mac). */
export function spawnSyncFed(command: string, args: readonly string[], stdin: Uint8Array, opts: Fed<SpawnSyncOptionsWithStringEncoding>): SpawnSyncReturns<string>;
export function spawnSyncFed(command: string, args: readonly string[], stdin: Uint8Array, opts?: Fed<SpawnSyncOptionsWithBufferEncoding>): SpawnSyncReturns<Buffer>;
export function spawnSyncFed(command: string, args: readonly string[], stdin: Uint8Array, opts: Fed<SpawnSyncOptionsWithStringEncoding> | Fed<SpawnSyncOptionsWithBufferEncoding> = {}): SpawnSyncReturns<string | Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "wsp-stdin-"));
  let fd: number;
  try {
    const path = join(dir, "in");
    writeFileSync(path, stdin, { mode: 0o600, flag: "wx" });
    fd = openSync(path, "r");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    return spawnSync(command, args, { ...opts, stdio: [fd, "pipe", "pipe"] });
  } finally {
    closeSync(fd);
  }
}
