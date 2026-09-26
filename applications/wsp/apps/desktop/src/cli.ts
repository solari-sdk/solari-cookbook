// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command the app bundles, run by the shim as node: the host's own
// bin, told that it runs behind the shim so the MCP install writes the shim's
// path into an agent's config and never this bundle's.
import { runBin, runningWsp, shimPath, wspHome } from "@wsp/host";

runBin(process.argv.slice(2), { ...runningWsp(), shim: shimPath(wspHome()) });
