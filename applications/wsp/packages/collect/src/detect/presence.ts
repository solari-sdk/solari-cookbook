// SPDX-License-Identifier: AGPL-3.0-only
import type { Host } from "../host.js";
import { type Found, found } from "./common.js";

export interface Presence extends Found {
  /** Whether the entry's command is on PATH. */
  bin: boolean;
}

/** Whether a catalog entry is on this computer: which of its config paths exist and whether its command is on
 * PATH; nothing when neither says so. The one rule every presence check reads. */
export async function presenceOf(host: Host, e: { configPaths: readonly string[]; bin: string }): Promise<Presence | undefined> {
  const f = await found(host, e.configPaths);
  const bin = await host.exec.which(e.bin);
  return f.paths.length === 0 && !bin ? undefined : { ...f, bin };
}
