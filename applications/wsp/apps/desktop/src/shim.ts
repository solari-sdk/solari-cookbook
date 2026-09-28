// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command the app installs: a shell script that runs this app's own
// binary as node on the command the bundle carries. Electron's binary is node
// once ELECTRON_RUN_AS_NODE is set, so the person needs no Node of their own.
// Where the bundle carries the daemon binary, the script runs its forwarder in
// front of that command, so every agent's `wsp mcp` rides the host already
// running rather than holding a node process of its own for the whole session.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { shellQuote } from "@wsp/protocol";

export interface ShimTarget {
  /** The app's executable, which runs as node. */
  execPath: string;
  /** The bundled command entry the executable runs. */
  script: string;
  /** The daemon binary the bundle carries for this computer, whose forwarder goes in front; absent where it carries none. */
  daemon?: string;
}

export function shimText(target: ShimTarget): string {
  const wsp = `${shellQuote(target.execPath)} ${shellQuote(target.script)}`;
  const line = target.daemon === undefined ? wsp : `${shellQuote(target.daemon)} forward --wsp-argv ${shellQuote(target.execPath)} --wsp-argv ${shellQuote(target.script)} --`;
  return `#!/bin/sh\n# The wsp app writes this on each launch; it runs the wsp the app bundles.\nELECTRON_RUN_AS_NODE=1 exec ${line} "$@"\n`;
}

/** Writes the shim at `path`, executable, unless one already says exactly this; a shim naming an app that moved is
 * rewritten. Says which happened. */
export function installShim(path: string, text: string): "written" | "kept" {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return "kept";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o755 });
  return "written";
}
