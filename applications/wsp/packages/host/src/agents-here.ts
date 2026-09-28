// SPDX-License-Identifier: AGPL-3.0-only
// The agents the desktop's first run lists: the catalog's, each read off this
// computer by the recipe scan's own detector, so the app and wsp recipe scan
// agree on what is here; whether its MCP config already names wsp; and the
// version its command answers with.
import { CATALOG_AGENTS, MCP_AGENTS } from "@wsp/catalog";
import { agentRowId, detectAgents, expand, firstLine, nodeHost, type Host } from "@wsp/collect";
import { MCP_SERVER_NAME } from "./mcp-install.js";

export interface AgentHere {
  id: string;
  name: string;
  /** The recipe scan found it here: its config or its command. */
  found: boolean;
  /** One of its MCP config files already names the wsp server. */
  configured: boolean;
  /** The number its command answers `--version` with, when the command is on PATH and answers with one. */
  version?: string;
}

/** Whether any of the agent's MCP config files names wsp; a file that is not its format names nothing. */
async function configured(host: Host, agentId: string): Promise<boolean> {
  const agent = MCP_AGENTS.find(a => a.id === agentId);
  if (agent === undefined) return false;
  for (const file of agent.mcp.files) {
    const text = await host.fs.readText(expand(host, file));
    if (text === undefined) continue;
    try {
      if (agent.mcp.format.read(text, host.home).some(s => s.name === MCP_SERVER_NAME)) return true;
    } catch {
      // Not the format: it names no server.
    }
  }
  return false;
}

/** The version number in the command's own answer; none when the command is not on PATH or answers without one. */
async function versionOf(host: Host, bin: string): Promise<string | undefined> {
  if (!(await host.exec.which(bin))) return undefined;
  return /\d+\.\d+(?:\.\d+)?/.exec(firstLine(await host.exec.run(bin, ["--version"])) ?? "")?.[0];
}

/** `versions` off skips the `--version` runs, for a reader that only needs to know what is here. */
export async function agentsHere(host: Host = nodeHost(), opts: { versions?: boolean } = {}): Promise<AgentHere[]> {
  const found = new Set((await detectAgents(host)).map(r => r.id));
  return Promise.all(
    CATALOG_AGENTS.map(async a => {
      const version = opts.versions === false ? undefined : await versionOf(host, a.bin);
      return { id: a.id, name: a.name, found: found.has(agentRowId(a.id)), configured: await configured(host, a.id), ...(version !== undefined ? { version } : {}) };
    }),
  );
}
