// SPDX-License-Identifier: AGPL-3.0-only
// Prints the manifest for the machine this runs on: JSON on stdout, a per-rung
// count and size on stderr so the JSON can be piped as is.
import { fmtBytes } from "@wsp/protocol";
import { collect } from "./collect.js";
import { nodeHost } from "./live-host.js";
import { RUNGS } from "./manifest.js";

const manifest = await collect(nodeHost());
for (const rung of RUNGS) {
  const rows = manifest.entries.filter(e => e.rung === rung);
  const bytes = rows.reduce((n, e) => n + e.bytes, 0);
  process.stderr.write(`${rung.padEnd(10)} ${String(rows.length).padStart(3)} rows ${fmtBytes(bytes).padStart(9)}\n`);
}
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
