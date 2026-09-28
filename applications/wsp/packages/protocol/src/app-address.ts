// SPDX-License-Identifier: AGPL-3.0-only
// The one address rule the app and the host share: which workspace a page
// opens on, which thread of it, and the screen a workspace's next thread is
// written on. The address is the app's one record of what a person is
// reading, so it is written on every pick and read on every refresh; wsp init
// writes the workspace form after its first fork, and a thread row's
// copy-link action the thread form. One writer and one reader live here, so
// no surface grows a hash parser of its own.

const PREFIX = "#w/";
const THREAD = "/t/";
const NEW = "/new";
/** The pairing code wsp init minted for the browser it opens, as the last segment of the hash: spent on the page's
 * first paint and written back out of the address, so what the person is reading never carries it. */
const CODE = "/c/";
/** The same code on a page opened on no workspace. */
const CODE_ALONE = "#c/";

/** What a page's address names. */
export interface AppAddress {
  readonly workspaceId: string;
  /** A thread of it, when the address names one. */
  readonly threadId?: string;
  /** Whether it names the screen the workspace's next thread is written on, which has no thread of its own yet. */
  readonly fresh?: boolean;
}

/** The hash that opens the app on a workspace. */
export const workspaceHash = (workspaceId: string): string => `${PREFIX}${encodeURIComponent(workspaceId)}`;

/** The hash for an address: a workspace, one thread of it, or its next thread's screen. */
export function appHash(address: AppAddress): string {
  const base = workspaceHash(address.workspaceId);
  if (address.threadId !== undefined) return `${base}${THREAD}${encodeURIComponent(address.threadId)}`;
  return address.fresh === true ? `${base}${NEW}` : base;
}

/** The hash wsp init opens the app on: the workspace it made, or none, with the code that lets the browser in. */
export function openingHash(code: string, workspaceId?: string): string {
  return `${workspaceId === undefined ? CODE_ALONE : `${workspaceHash(workspaceId)}${CODE}`}${encodeURIComponent(code)}`;
}

/** The pairing code a hash carries and the hash left once it is taken out, or nothing when it carries none. */
export function pairingCodeOf(hash: string): { code: string; rest: string } | undefined {
  const alone = hash.startsWith(CODE_ALONE);
  const cut = alone ? 0 : hash.startsWith(PREFIX) ? hash.lastIndexOf(CODE) : -1;
  if (cut === -1) return undefined;
  const code = decodeURIComponent(hash.slice(cut + (alone ? CODE_ALONE.length : CODE.length)));
  return code === "" ? undefined : { code, rest: hash.slice(0, cut) };
}

/** What a hash names, or nothing: every other hash is the app's own (#gallery) or none at all. A code riding the
 * end of it is not part of what it names. */
export function addressFromHash(hash: string): AppAddress | undefined {
  const named = pairingCodeOf(hash)?.rest ?? hash;
  if (!named.startsWith(PREFIX)) return undefined;
  const rest = named.slice(PREFIX.length);
  const cut = rest.indexOf(THREAD);
  const fresh = cut === -1 && rest.endsWith(NEW);
  const workspaceId = decodeURIComponent(fresh ? rest.slice(0, -NEW.length) : cut === -1 ? rest : rest.slice(0, cut));
  if (workspaceId === "") return undefined;
  const threadId = cut === -1 ? "" : decodeURIComponent(rest.slice(cut + THREAD.length));
  return { workspaceId, ...(threadId === "" ? {} : { threadId }), ...(fresh ? { fresh: true } : {}) };
}
