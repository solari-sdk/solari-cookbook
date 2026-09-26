// SPDX-License-Identifier: AGPL-3.0-only
// One road for putting a file's bytes on a machine, whichever backend holds
// it: the provider's signed upload URL where it mints one, else the backend's
// own road. Every caller that used to reach for uploadUrl comes through here,
// so a backend without signed URLs is not a road each caller has to know about.

import type { BytesLanded, Machine } from "./machine.js";

export interface LandBytesOptions {
  /** The upload's transport for the signed URL road; tests hand in their own. */
  fetch?: typeof globalThis.fetch;
  /** How long the backend's own road may take; its own pace when absent. */
  timeoutMs?: number;
}

/** Whether this machine carries a road of the backend's own for bytes. The one place that reading lives, so no
 * caller tests the method itself. */
export function hasByteRoad(machine: Pick<Machine, "putBytes">): boolean {
  return machine.putBytes !== undefined;
}

/** Whether bytes can be put on this machine at all: the provider mints a signed URL, or the backend carries its own
 * road. The one reading, so nothing offers to put a daemon where the bytes could not land. */
export function landsBytes(capabilities: { signedUrls: boolean }, machine: Pick<Machine, "putBytes">): boolean {
  return capabilities.signedUrls || hasByteRoad(machine);
}

/** Puts one file on the machine, and answers what the road it took counted. The backend's own road goes first: it
 * is one call to the provider where the signed URL is two, and it is the only road on a backend that mints none. */
export async function landBytes(machine: Pick<Machine, "id" | "putBytes" | "uploadUrl">, path: string, bytes: Uint8Array, opts: LandBytesOptions = {}): Promise<BytesLanded | undefined> {
  if (machine.putBytes !== undefined) {
    return (await machine.putBytes(path, bytes, opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {})) ?? undefined;
  }
  const url = await machine.uploadUrl(path);
  // A copy into a plain buffer: the fetch body types take an ArrayBuffer's view, not every Uint8Array flavour.
  const put = await (opts.fetch ?? globalThis.fetch)(url, { method: "PUT", body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`${path} did not land on ${machine.id}: HTTP ${put.status}`);
  return undefined;
}
