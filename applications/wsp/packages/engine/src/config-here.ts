// SPDX-License-Identifier: AGPL-3.0-only
// The one config write run on this computer, for a caller with no road to a
// machine: the same line every road runs, through this computer's own sh.
import { configRefusal, configWriteLine } from "@wsp/catalog";
import type { ExecResult } from "./machine.js";
import { spawnSyncFed } from "./spawn-fed.js";

const WRITE_MS = 60_000;

/** What a config write came to: nothing where it landed, a usage refusal where the line refused, else the words that
 * the file stands as it was; `shown` says a path the way the person reads it. */
export function configLanded(res: ExecResult, file: string, shown: (path: string) => string = p => p): void {
  const said = configRefusal(res, file, shown);
  if (said !== undefined) throw Object.assign(new Error(said), { kind: "usage" });
  const first = (res.stderr || res.stdout).trim().split("\n")[0] || `exit ${res.exitCode}`;
  if (res.exitCode !== 0) throw new Error(`${shown(file)} stands as it was: the write did not finish (${first}).`);
}

/** Writes the text over the file inside `base` by the one config write. `sum` is the file's checksum as read
 * (configSum), absent where there was no file. */
export function writeConfigHere(file: string, base: string, sum: string | undefined, text: string, shown?: (path: string) => string): void {
  const bytes = Buffer.from(text);
  const res = spawnSyncFed("/bin/sh", ["-c", configWriteLine({ file, base, bytes: bytes.length, ...(sum !== undefined ? { sum } : {}) })], bytes, {
    encoding: "utf8",
    timeout: WRITE_MS,
    // The line runs the system's own tools, never whatever a caller's PATH puts first or leaves out.
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  configLanded({ exitCode: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr || (res.error?.message ?? "") }, file, shown);
}
