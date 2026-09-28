// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSyncFed } from "../src/spawn-fed.js";

/** This computer's tar run over an archive the test holds, which it reads on stdin, answering tar's stdout. */
export function tarRead(args: readonly string[], archive: Uint8Array): Buffer {
  const ran = spawnSyncFed("tar", args, archive, { timeout: 60_000 });
  if (ran.error !== undefined || ran.status !== 0) throw new Error(`tar ${args.join(" ")} did not finish whole (exit ${String(ran.status)}): ${ran.error?.message ?? ran.stderr.toString()}`);
  return ran.stdout;
}
