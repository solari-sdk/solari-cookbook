// SPDX-License-Identifier: AGPL-3.0-only
// The window moves between hosts. The app's own host is one session and every
// host on the account another; whichever the window is on is what the origin
// gate on every bridge call reads, so a page from anywhere else is answered
// nothing. The hosts are the records wsp hosts writes off the account, read
// through the one module the command line uses, so wsp hosts and the Hosts
// menu are one list, less this computer's own record on the account, which the
// row for here is. The app's own host is never stopped by a move: a person who
// comes back finds it as they left it.
import { accountHosts, aimedHost, dialHost, hostTokenFor, noSuchHostLine, readHost, type HostRecord } from "@wsp/host";
import type { HostOutcome, HostsView } from "@wsp/protocol";
import { remoteSession, type HostSession } from "./host-lifecycle.js";

export interface SwitcherDeps {
  /** The app's own host, attached or started; the window opens on it and returns to it. */
  local: HostSession;
  /** The wsp home holding the hosts folder, the same one the command line reads. */
  home: string;
  /** This computer's state file, whose relay record says which account host is this computer. */
  statePath: string;
  /** What this computer is called in the list. */
  here: string;
  /** Puts the window on a session, at the fragment the caller names; the page opens on what that fragment says. */
  load(session: HostSession, hash?: string): Promise<void>;
  log(line: string): void;
  dial?: typeof dialHost;
}

export interface HostSwitcher {
  current(): HostSession;
  view(): HostsView;
  /** What the page opens the host the window is on with: the device token for a host somewhere else, and for the
   * host here its own token, which a page served beyond loopback carries no more than a relayed one does. */
  token(): string | undefined;
  /** Puts the window on a host on the account, or on this computer for null, loaded at the fragment where one is named. */
  to(alias: string | null, hash?: string): Promise<HostOutcome>;
}

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function hostSwitcher(deps: SwitcherDeps): HostSwitcher {
  let current = deps.local;
  const dial = deps.dial ?? dialHost;

  /** A record off the account, dialled once before the window moves: the first dial admits this computer over there
   * and a token that host no longer takes is renewed on the same road the command line takes, so the page is handed
   * one that opens. What the dial wrote under the alias is what the session carries. */
  const admitted = async (alias: string, record: HostRecord): Promise<HostRecord> => {
    // The name goes through the rule every verb reads which host it runs against by, so a record holding a token
    // and no key for the host is refused here as it is there rather than dialled.
    (await dial(deps.statePath, { aim: aimedHost(deps.statePath, { host: alias, home: deps.home }), home: deps.home })).close();
    return readHost(deps.home, alias) ?? record;
  };

  const moveTo = async (session: HostSession, hash?: string): Promise<void> => {
    current = session;
    deps.log(`on ${session.label} at ${session.url}`);
    await deps.load(session, hash);
  };

  return {
    current: () => current,
    // Every host on the account less this computer's own record there: the row for here already is that host, and a
    // row for it would dial this computer through the relay and admit it as a device of itself.
    view: () => ({
      here: deps.here,
      current: current.alias ?? null,
      hosts: accountHosts(deps.statePath, deps.home).map(({ alias, record }) => ({ alias, url: record.url })),
    }),
    token: () => (current.remote ? current.deviceToken : hostTokenFor(deps.statePath)),
    async to(alias, hash) {
      try {
        if (alias === null) {
          await moveTo(deps.local, hash);
          return { ok: true };
        }
        const held = readHost(deps.home, alias);
        if (held === undefined) throw new Error(noSuchHostLine(alias, deps.home));
        const record = await admitted(alias, held);
        await moveTo(remoteSession(alias, record, record.url), hash);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: text(e) };
      }
    },
  };
}
