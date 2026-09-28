// SPDX-License-Identifier: AGPL-3.0-only
// The line that stages the daemon binary this wsp needs beside it, one row per
// road a wsp is installed by, read off the process this wsp is running as. The
// binary is not built by any node build, so a host rebuilt without it runs
// beside the one that was there before; every sentence about a daemon that is
// behind on this computer carries this line as its fix. The line that moves
// this wsp onto a newer release reads the same road.
import { sep } from "node:path";
import type { RunningWsp } from "./mcp-install.js";

/** The published package, as an install line names it. */
const NPM_PACKAGE = "@zingzy/wsp";

type Road = "npm" | "app" | "checkout";

/** The road this wsp was installed by: a bin under a global node_modules is an npm install, a bin inside the
 * desktop app's bundle moves with the app, and anything else is a checkout. */
function roadOf(run: Pick<RunningWsp, "argv" | "shim">): Road {
  const parts = (run.shim ?? run.argv[1] ?? "").split(sep);
  if (parts.includes("node_modules")) return "npm";
  if (parts.some(part => part.endsWith(".app"))) return "app";
  return "checkout";
}

/** What each road says: the line that puts the right daemon beside this wsp (the npm install again, the app's own
 * update, or in a checkout a cargo build placed by the script that stages it), and the line that moves this wsp onto
 * a newer release. */
const ROAD_LINES: Readonly<Record<Road, { daemon: string; release: (version: string) => string }>> = {
  npm: { daemon: `npm i -g ${NPM_PACKAGE}`, release: version => `npm i -g ${NPM_PACKAGE}@${version}` },
  app: { daemon: "updating the wsp app", release: () => "updating the wsp app" },
  checkout: { daemon: "a cargo build of the daemon and node packages/wspx/scripts/daemon-binary.mjs --from its binary", release: () => "a pull of the checkout and a build" },
};

export const daemonFixLine = (run: Pick<RunningWsp, "argv" | "shim">): string => ROAD_LINES[roadOf(run)].daemon;

export const releaseUpdateLine = (run: Pick<RunningWsp, "argv" | "shim">, version: string): string => ROAD_LINES[roadOf(run)].release(version);
