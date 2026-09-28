// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from "node:url";
import type { HostsView } from "@wsp/protocol";

/** Whether a frame's url is the host's own page: the same origin as the app url. The onboarding page (file:),
 * about:blank, a missing frame and anything the window navigated to elsewhere are not. */
export function fromAppPage(frameUrl: string | undefined, appUrl: string): boolean {
  if (frameUrl === undefined) return false;
  try {
    const frame = new URL(frameUrl);
    return frame.origin !== "null" && frame.origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

/** Whether a frame's url is the app's own onboarding page: the file it was loaded from, whatever query rides on it. */
export function fromOnboardingPage(frameUrl: string | undefined, pagePath: string): boolean {
  if (frameUrl === undefined) return false;
  try {
    const frame = new URL(frameUrl);
    return frame.protocol === "file:" && fileURLToPath(frame) === pagePath;
  } catch {
    return false;
  }
}

/** The host the window is on, as every gate on a bridge call reads it. */
export interface BridgeSession {
  url: string;
  /** True for a host on another computer, whose page is served by a computer this one does not own. */
  remote: boolean;
}

/** What a page served by a host somewhere else may ask the shell for: the device token the shell holds for that
 * host, the hosts list, a move back to this computer, and the shell's own presentation. Everything that reads this
 * computer or writes its host records is the app's own host's page alone. */
const REMOTE_CHANNELS: ReadonlySet<string> = new Set(["hosts:token", "hosts:list", "hosts:switch", "menu:context", "terminal:focus", "theme:set", "needs-you:say"]);

/** Whether a page on this session may call this channel: every one on the app's own host, the narrow set above on
 * a host somewhere else. */
export function bridgeReach(session: BridgeSession, channel: string): boolean {
  return !session.remote || REMOTE_CHANNELS.has(channel);
}

/** The one gate on every bridge call: the frame is the page of the host the window is on, and the channel is one
 * that page may call. Read before the handler runs, so a refused call moves nothing. */
export function allowed(frameUrl: string | undefined, session: BridgeSession | undefined, channel: string): boolean {
  return session !== undefined && fromAppPage(frameUrl, session.url) && bridgeReach(session, channel);
}

/** What a page is told when the shell will not answer it: the channel and nothing about why, since which page it
 * is decides that and the page already knows which host served it. */
export const notForThisPage = (channel: string): string => `${channel}: not for this page`;

/** The hosts a page on this session is shown: the whole list on the app's own host, and on a host somewhere else
 * this computer and the host the window is on alone, so a compromised box learns no other host of the owner's.
 * The shell's own Hosts menu reads the whole list either way. */
export function hostsViewFor(session: BridgeSession, view: HostsView): HostsView {
  return session.remote ? { ...view, hosts: view.hosts.filter(h => h.alias === view.current) } : view;
}
