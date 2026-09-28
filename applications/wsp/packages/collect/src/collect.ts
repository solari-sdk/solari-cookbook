// SPDX-License-Identifier: AGPL-3.0-only
import { detectAgents } from "./detect/agents.js";
import type { Detector } from "./detect/common.js";
import { detectIdentity } from "./detect/identity.js";
import { detectLogins } from "./detect/logins.js";
import { detectMcp } from "./detect/mcp.js";
import { detectShell } from "./detect/shell.js";
import { shellSources } from "./detect/sources.js";
import { detectTerminalFont } from "./detect/terminal.js";
import { detectToolchains } from "./detect/toolchains.js";
import { detectTools } from "./detect/tools.js";
import type { Host } from "./host.js";
import { type Manifest, type ManifestEntry, RUNGS, type Rung, parseManifest } from "./manifest.js";

export const DETECTORS: Record<Rung, Detector> = {
  identity: detectIdentity,
  shell: async host => {
    const rows = await detectShell(host);
    await shellSources(host, rows);
    return [...rows, ...(await detectTerminalFont(host))];
  },
  toolchains: detectToolchains,
  tools: detectTools,
  agents: async host => [...(await detectAgents(host)), ...(await detectMcp(host))],
  logins: detectLogins,
};

export interface CollectOptions {
  /** Called after each rung's detector with its row count, so a spinner can count rows as they land. */
  onRung?: (rung: Rung, count: number) => void;
}

/** Runs every rung's detector in ladder order and validates the result against the schema. */
export async function collect(host: Host, opts: CollectOptions = {}): Promise<Manifest> {
  const entries: ManifestEntry[] = [];
  for (const rung of RUNGS) {
    const rows = await DETECTORS[rung](host, entries);
    opts.onRung?.(rung, rows.length);
    entries.push(...rows);
  }
  return parseManifest({ entries });
}
