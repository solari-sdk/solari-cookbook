// SPDX-License-Identifier: AGPL-3.0-only
// The window's side of the app's address: what this page names now, and the
// writing of what the person is reading back into it. The address is the one
// record of that, so it is replaced rather than pushed: a pick inside the app
// is not a page to go back from, and a back step would leave the app showing
// one thread while the address named another. The shape lives in the protocol.
import { addressFromHash, appHash, pairingCodeOf, type AppAddress } from "@wsp/protocol";

/** What this page's address names, or nothing on a page whose hash names no workspace. */
export function readAddress(): AppAddress | undefined {
  return typeof window === "undefined" ? undefined : addressFromHash(window.location.hash);
}

/** Writes what the person is reading into the address; null leaves the page with no address at all. */
export function writeAddress(address: AppAddress | null): void {
  if (typeof window === "undefined") return;
  const hash = address === null ? "" : appHash(address);
  if (window.location.hash === hash) return;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
}

/** The pairing code wsp init put in this page's address, taken out of it as it is read: a second look finds none,
 * and what the person is reading is written back without it. */
export function takePairingCode(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const found = pairingCodeOf(window.location.hash);
  if (found === undefined) return undefined;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${found.rest}`);
  return found.code;
}

/** The whole link to an address, which is what a person pastes elsewhere. */
export const addressLink = (address: AppAddress): string => `${window.location.origin}${window.location.pathname}${appHash(address)}`;

const HOME_PREFIX = "#p/";

/** The project whose home this page's address names, which the protocol's address does not carry: a home is the
 * app's own screen, not a workspace or a thread another client could open. */
export function readProjectHome(): string | null {
  if (typeof window === "undefined" || !window.location.hash.startsWith(HOME_PREFIX)) return null;
  return decodeURIComponent(window.location.hash.slice(HOME_PREFIX.length)) || null;
}

/** Writes a project's home into the address, so a reload opens it again. */
export function writeProjectHome(projectId: string): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${HOME_PREFIX}${encodeURIComponent(projectId)}`);
}
