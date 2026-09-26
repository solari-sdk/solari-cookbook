// SPDX-License-Identifier: AGPL-3.0-only
import { LOOPBACK } from "@wsp/protocol";
import type { Machine, PreviewReach } from "./machine.js";

/** Reuse a minted reach while more than this remains before its expiry; below it, remint. On a provider whose
 * tokens live an hour this keeps URLs younger than about fifty minutes in circulation. */
export const PREVIEW_REFRESH_MARGIN_MS = 10 * 60_000;

/** The in-guest daemon's port (mirrors DAEMON_DEFAULT_PORT in @wsp/protocol; the engine sits under the protocol
 * and cannot import it). */
export const DAEMON_PORT = 7070;

/** Whether the daemon is serving, asked from inside the guest, in the words a container image can answer in:
 * bash's own network road, since such an image ships neither ss nor curl. The one reading of the guest's own
 * loopback, so the deploy that waits for the daemon and the reach that asks after it agree. */
export const DAEMON_LISTENING_CHECK = `(exec 3<>/dev/tcp/${LOOPBACK}/${DAEMON_PORT}) 2>/dev/null`;

export function previewIsFresh(reach: PreviewReach, now = Date.now()): boolean {
  return reach.expiresAt - now > PREVIEW_REFRESH_MARGIN_MS;
}

/** Hand back `current` while it is fresh, otherwise mint a replacement.
 * Reminting returns the same hostname with a rotated token, so holders only
 * ever swap tokens, never URLs. */
export async function refreshPreviewToken(
  machine: Machine,
  port: number,
  current?: PreviewReach,
  now = Date.now(),
): Promise<PreviewReach> {
  if (current && previewIsFresh(current, now)) return current;
  if (!machine.previewUrl) {
    throw new Error(`machine ${machine.id} is on a backend without preview URLs`);
  }
  return machine.previewUrl(port);
}
