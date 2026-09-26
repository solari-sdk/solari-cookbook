// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";

/** Where the desktop app puts the wsp command on this computer: a small script under the wsp home that runs the
 * host the app bundles. A script and never a link into the app bundle, since macOS translocation and updates move
 * that path; the app rewrites it on every launch. The MCP configs the app writes run this same path. */
export const shimPath = (home: string): string => join(home, "bin", "wsp");
