// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { keyedStep } from "./listing.js";
import { pyData } from "./py.js";
import { keyedEntries, keyedSessions, moveKeyedDirectories, type ProjectStateResolver } from "./resolver.js";

/** The sessions directory name: two dashes, the resolved path without its leading slash with every slash,
 * backslash and colon replaced by a dash, two dashes; dots and underscores stay. */
export const piProjectKey = (path: string): string => `--${path.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;
/** The same rule for the machine, where nothing can run this one. */
const KEY_PY = `lambda p: "--" + re.sub(${pyData("[/\\\\:]")}, "-", re.sub(${pyData("^/")}, "", p)) + "--"`;
const SESSIONS = "sessions";
const ROOTS = [SESSIONS];

export const piResolver: ProjectStateResolver = {
  agent: "pi",
  carry: "moves",
  states: ["sessions"],
  roots: ROOTS,
  async move(home, from, to) {
    const { files, changed } = await moveKeyedDirectories(join(home, SESSIONS), piProjectKey, from, to);
    return changed > 0 ? [{ state: "sessions", files, changed }] : [];
  },
  sessions: (home, path) => keyedSessions(join(home, SESSIONS), piProjectKey, path),
  entries: (home, path) => keyedEntries(join(home, SESSIONS), piProjectKey, path),
  listing: home => [keyedStep(join(home, SESSIONS), KEY_PY)],
};
