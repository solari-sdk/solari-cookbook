// SPDX-License-Identifier: AGPL-3.0-only
// Names that mean a cache, an install or Finder metadata: what a machine
// recreates and a copy never carries. The project bundle and the nap-time
// vault skip these.

export { CACHE_DIRS } from "@wsp/protocol";
/** Finder's per-directory metadata, a file by exact name; it means nothing on a Linux machine. */
export const FINDER_METADATA = ".DS_Store";
