// SPDX-License-Identifier: AGPL-3.0-only
// How a host restarts itself on the files it was installed from, one road per
// way it comes up. The service exits and its manager brings it back on the
// same line; a verb's host starts its successor on the ports it held, so a tab
// on them reconnects; a host wsp up holds in a terminal refuses, since only
// that terminal brings it back. The app's own road lives in the desktop shell.
import { UP_RESTART_LINE, type HostShape } from "@wsp/protocol";
import type { HostStarted } from "./host-lock.js";

/** What a road reads and stops of the host it restarts. */
export interface RestartingHost {
  port: number;
  wsPort: number;
  close(): Promise<void>;
}

export interface RestartRoad {
  shape: HostShape;
  /** Why a restart on this road would not bring the host back, and nothing where it does. */
  refusal?: string;
  restart(host: RestartingHost): Promise<void>;
}

export interface RestartDeps {
  exit(code: number): void;
  /** Starts the host that replaces this one on these ports and settles once it serves. */
  respawn(ports: { port: number; wsPort: number }): Promise<unknown>;
  log(line: string): void;
}

/** Closes the host, and says in its log where the close failed: the process exits either way, since a host half
 * closed serves nothing and holds its place. */
async function closed(host: RestartingHost, deps: RestartDeps): Promise<boolean> {
  try {
    await host.close();
    return true;
  } catch (e) {
    deps.log(`the host did not close cleanly: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export function restartRoads(deps: RestartDeps): Readonly<Record<HostStarted, RestartRoad>> {
  return {
    // launchd's KeepAlive and systemd's Restart=always bring back a unit that exits, whatever its code.
    service: {
      shape: "service",
      restart: async host => deps.exit((await closed(host, deps)) ? 0 : 1),
    },
    // The close drops the lock and frees the ports before the successor takes both.
    verb: {
      shape: "verb",
      restart: async host => {
        if (!(await closed(host, deps))) {
          deps.exit(1);
          return;
        }
        try {
          await deps.respawn({ port: host.port, wsPort: host.wsPort });
        } catch (e) {
          deps.log(`the host that was to replace this one did not serve: ${e instanceof Error ? e.message : String(e)}`);
          deps.exit(1);
          return;
        }
        deps.exit(0);
      },
    },
    up: {
      shape: "up",
      refusal: UP_RESTART_LINE,
      restart: () => Promise.reject(new Error(UP_RESTART_LINE)),
    },
  };
}
