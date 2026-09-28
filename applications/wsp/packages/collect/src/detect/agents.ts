// SPDX-License-Identifier: AGPL-3.0-only
import { CATALOG_AGENTS } from "@wsp/catalog";
import type { Host } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { entry } from "./common.js";
import { presenceOf } from "./presence.js";

interface Agent {
  id: string;
  label: string;
  bin: string;
  /** Config that travels with the agent. An allowlist, because the login file
   * (auth.json, .credentials.json) sits next to it and belongs to the logins
   * rung, and because plugin clones and node_modules reinstall from their index. */
  config: readonly string[];
  /** Config the agent rewrites while it runs: it travels, and never decides whether a golden is the same golden. */
  volatile?: readonly string[];
}

/** Aider is not a catalog agent (its project state has no measured resolver, so wsp does not ship it); its row stays for laptops that have it. */
const AIDER: Agent = { id: "aider", label: "Aider", bin: "aider", config: ["~/.aider.conf.yml", "~/.aider.model.settings.yml", "~/.aider.model.metadata.json"] };

/** The catalog's agents in its order, each with the config that travels, then Aider. */
export const AGENTS: readonly Agent[] = [...CATALOG_AGENTS.map((a): Agent => ({ id: a.id, label: a.name, bin: a.bin, config: a.configPaths, ...(a.volatile !== undefined ? { volatile: a.volatile } : {}) })), AIDER];

/** The manifest row id of an agent, the one spelling readers match on. */
export const agentRowId = (id: string): string => `agents/${id}`;

export async function detectAgents(host: Host): Promise<ManifestEntry[]> {
  const rows: ManifestEntry[] = [];
  for (const a of AGENTS) {
    const p = await presenceOf(host, { configPaths: a.config, bin: a.bin });
    if (p === undefined) continue;
    rows.push(entry({ rung: "agents", id: agentRowId(a.id), label: a.label, paths: p.paths, bytes: p.bytes, ...(a.volatile !== undefined ? { volatile: a.volatile } : {}) }));
  }
  return rows;
}
