// SPDX-License-Identifier: AGPL-3.0-only
// This Mac's folders as the host lists them, for the fixtures the render tests
// drive: one home folder as the only root, a level longer than the list's own
// height so its scroll is laid out, a folder whose name is too long for the
// row beside short ones, repositories among plain folders, and dot-named
// folders counted rather than listed until they are asked for.
import type { HostFolder, HostFolderListing } from "@wsp/protocol";

export const HOST_HOME = "/Users/me";

const folder = (path: string, repo = false): HostFolder => ({ path, repo });
const LEVELS: Record<string, HostFolder[]> = {
  [HOST_HOME]: [
    folder(`${HOST_HOME}/Applications`),
    folder(`${HOST_HOME}/Desktop`),
    folder(`${HOST_HOME}/Documents`),
    folder(`${HOST_HOME}/Downloads`),
    folder(`${HOST_HOME}/Movies`),
    folder(`${HOST_HOME}/Music`),
    folder(`${HOST_HOME}/Pictures`),
    folder(`${HOST_HOME}/code`),
  ],
  [`${HOST_HOME}/code`]: [
    folder(`${HOST_HOME}/code/billing-reconciliation-nightly-settlements-batch`, true),
    folder(`${HOST_HOME}/code/notes`),
    folder(`${HOST_HOME}/code/spoo`, true),
    folder(`${HOST_HOME}/code/wsp`, true),
  ],
  [`${HOST_HOME}/code/spoo`]: [folder(`${HOST_HOME}/code/spoo/api`), folder(`${HOST_HOME}/code/spoo/web`)],
};
const HELD: Record<string, HostFolder[]> = { [`${HOST_HOME}/code`]: [folder(`${HOST_HOME}/code/.cache`), folder(`${HOST_HOME}/code/.venv`)] };

/** The host's answer for one level, sorted as the host sorts it; a folder no level here names is refused, as a path
 * outside the roots is. */
export function fakeHostFolders(): (dir?: string, hidden?: boolean) => Promise<HostFolderListing> {
  return async (dir, hidden) => {
    const at = dir ?? HOST_HOME;
    const level = LEVELS[at];
    if (level === undefined) throw new Error(`${at} is outside the folders wsp browses on this computer: ${HOST_HOME}`);
    const held = HELD[at] ?? [];
    return {
      dir: at,
      roots: [HOST_HOME],
      folders: [...level, ...(hidden === true ? held : [])].sort((a, b) => a.path.localeCompare(b.path)),
      hidden: held.length,
    };
  };
}
